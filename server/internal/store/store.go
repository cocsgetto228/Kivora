// Package store is the whole persistence layer: an append-only log on disk and
// the indexes over it in memory. See wal.go for the file format.
//
// Everything above this package works with the structs in models.go, so
// replacing this engine with PostgreSQL means implementing the same method set
// and nothing else. docs/reference/schema.sql is the relational shape of the
// same data for anyone who wants to do that.
package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
	ErrDenied   = errors.New("forbidden")
)

type Options struct {
	Dir          string
	Sync         SyncMode
	SyncInterval time.Duration
	// CompactOnOpen rewrites the log at startup when more than this fraction
	// of it is superseded records. 0 disables automatic compaction.
	CompactRatio float64
}

type memberRec struct {
	UserID      string `json:"u"`
	Role        string `json:"r"`
	JoinedAt    int64  `json:"j"`
	LastReadSeq int64  `json:"lr"`
	Muted       bool   `json:"m"`
	Archived    bool   `json:"a,omitempty"`
	Pinned      bool   `json:"p,omitempty"`
}

type preKeyRec struct {
	ID   string `json:"id"`
	Pub  []byte `json:"p"`
	Used bool   `json:"u"`
}

type msgRec struct {
	ID           string   `json:"id"`
	ChannelID    string   `json:"c"`
	Seq          int64    `json:"s"`
	SenderID     string   `json:"sd"`
	SenderDevice string   `json:"sv"`
	Suite        string   `json:"su"`
	Kind         string   `json:"k"`
	ReplyTo      string   `json:"rt,omitempty"`
	CreatedAt    int64    `json:"ts"`
	EditedAt     int64    `json:"e,omitempty"`
	Deleted      bool     `json:"d,omitempty"`
	Pinned       bool     `json:"pin,omitempty"`
	Attachments  []string `json:"at,omitempty"`

	Body    blobRef   `json:"b"`
	Header  blobRef   `json:"h"`
	KeyRefs []blobRef `json:"kr,omitempty"`
}

type Store struct {
	mu  sync.RWMutex
	w   *wal
	opt Options

	users      map[string]*User
	byUsername map[string]string

	devices       map[string]*Device
	devicesByUser map[string][]string
	prekeys       map[string][]*preKeyRec

	sessions map[string]*Session

	channels       map[string]*Channel
	channelsBySlug map[string]string
	members        map[string]map[string]*memberRec
	userChannels   map[string]map[string]bool

	messages    map[string]*msgRec
	channelMsgs map[string][]*msgRec

	uploads map[string]*uploadRec

	seenDirty map[string]bool
	stopFlush chan struct{}
	closeOnce sync.Once
}

// Open replays the log in dir and returns a ready store.
func Open(opt Options) (*Store, error) {
	if opt.Sync == "" {
		opt.Sync = SyncAlways
	}
	if opt.SyncInterval <= 0 {
		opt.SyncInterval = 200 * time.Millisecond
	}
	s := &Store{
		opt:            opt,
		users:          map[string]*User{},
		byUsername:     map[string]string{},
		devices:        map[string]*Device{},
		devicesByUser:  map[string][]string{},
		prekeys:        map[string][]*preKeyRec{},
		sessions:       map[string]*Session{},
		channels:       map[string]*Channel{},
		channelsBySlug: map[string]string{},
		members:        map[string]map[string]*memberRec{},
		userChannels:   map[string]map[string]bool{},
		messages:       map[string]*msgRec{},
		channelMsgs:    map[string][]*msgRec{},
		uploads:        map[string]*uploadRec{},
		seenDirty:      map[string]bool{},
		stopFlush:      make(chan struct{}),
	}
	w, err := openWAL(opt.Dir, opt.Sync, opt.SyncInterval)
	if err != nil {
		return nil, err
	}
	s.w = w
	if err := w.replay(s.applyRecord); err != nil {
		return nil, err
	}
	s.dropExpiredSessionsLocked()
	if opt.CompactRatio > 0 && s.garbageRatio() > opt.CompactRatio {
		if err := s.Compact(); err != nil {
			return nil, err
		}
	}
	go s.flushLoop()
	return s, nil
}

func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		close(s.stopFlush)
		s.flushSeen()
		err = s.w.close()
	})
	return err
}

// Stats is what the admin endpoint and the logs report.
func (s *Store) Stats() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return map[string]any{
		"users":    len(s.users),
		"devices":  len(s.devices),
		"channels": len(s.channels),
		"messages": len(s.messages),
		"sessions": len(s.sessions),
		"uploads":  len(s.uploads),
		"logBytes": s.w.liveBytes + s.w.bytesWritten,
	}
}

func now() int64 { return time.Now().UnixMilli() }

// ---------------------------------------------------------------- replay

func (s *Store) applyRecord(t recordType, data json.RawMessage) error {
	switch t {
	case recUser:
		var u User
		if err := json.Unmarshal(data, &u); err != nil {
			return err
		}
		s.users[u.ID] = &u
		s.byUsername[u.Username] = u.ID
	case recUserUpdate:
		var p struct {
			ID, DisplayName, Bio, Avatar string
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if u := s.users[p.ID]; u != nil {
			u.DisplayName, u.Bio, u.Avatar = p.DisplayName, p.Bio, p.Avatar
		}
	case recUserFlags:
		var p struct {
			ID                 string
			IsAdmin, Suspended bool
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if u := s.users[p.ID]; u != nil {
			u.IsAdmin, u.Suspended = p.IsAdmin, p.Suspended
		}
	case recUserSeen:
		var p struct {
			ID string
			At int64
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if u := s.users[p.ID]; u != nil {
			u.LastSeenAt = p.At
		}
	case recDevice:
		var d Device
		if err := json.Unmarshal(data, &d); err != nil {
			return err
		}
		s.devices[d.ID] = &d
		s.devicesByUser[d.UserID] = append(s.devicesByUser[d.UserID], d.ID)
	case recDeviceRevk:
		var p struct{ ID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if d := s.devices[p.ID]; d != nil {
			d.Revoked = true
		}
	case recPreKeyAdd:
		var p struct {
			DeviceID string
			Keys     []*preKeyRec
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		s.prekeys[p.DeviceID] = append(s.prekeys[p.DeviceID], p.Keys...)
	case recPreKeyUse:
		var p struct{ DeviceID, ID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		for _, k := range s.prekeys[p.DeviceID] {
			if k.ID == p.ID {
				k.Used = true
			}
		}
	case recSession:
		var p struct {
			Hash string
			Sess Session
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		s.sessions[p.Hash] = &p.Sess
	case recSessionDel:
		var p struct{ Hash string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		delete(s.sessions, p.Hash)
	case recSessionBind:
		var p struct{ Hash, DeviceID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if sess := s.sessions[p.Hash]; sess != nil {
			sess.DeviceID = p.DeviceID
		}
	case recChannel:
		var c Channel
		if err := json.Unmarshal(data, &c); err != nil {
			return err
		}
		c.Members = nil
		s.channels[c.ID] = &c
		if c.Slug != "" {
			s.channelsBySlug[c.Slug] = c.ID
		}
		if s.members[c.ID] == nil {
			s.members[c.ID] = map[string]*memberRec{}
		}
	case recChannelMeta:
		var p struct{ ID, Name, Topic, Avatar string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if c := s.channels[p.ID]; c != nil {
			c.Name, c.Topic, c.Avatar = p.Name, p.Topic, p.Avatar
		}
	case recChannelTTL:
		var p struct {
			ID  string
			TTL int64
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if c := s.channels[p.ID]; c != nil {
			c.TTLSeconds = p.TTL
		}
	case recMemberAdd:
		var p struct {
			ChannelID string
			M         memberRec
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		s.addMemberIndex(p.ChannelID, &p.M)
	case recMemberDel:
		var p struct{ ChannelID, UserID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		s.removeMemberIndex(p.ChannelID, p.UserID)
	case recMemberFlags:
		var p struct {
			ChannelID, UserID       string
			Archived, Pinned, Muted bool
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.members[p.ChannelID][p.UserID]; m != nil {
			m.Archived, m.Pinned, m.Muted = p.Archived, p.Pinned, p.Muted
		}
	case recMsgPin:
		var p struct {
			ID     string
			Pinned bool
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.messages[p.ID]; m != nil {
			m.Pinned = p.Pinned
		}
	case recUpload:
		var u uploadRec
		if err := json.Unmarshal(data, &u); err != nil {
			return err
		}
		s.uploads[u.Meta.ID] = &u
	case recUploadDel:
		var p struct{ ID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		delete(s.uploads, p.ID)
	case recMemberRead:
		var p struct {
			ChannelID, UserID string
			Seq               int64
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.members[p.ChannelID][p.UserID]; m != nil && m.LastReadSeq < p.Seq {
			m.LastReadSeq = p.Seq
		}
	case recMessage:
		var m msgRec
		if err := json.Unmarshal(data, &m); err != nil {
			return err
		}
		s.indexMessage(&m)
	case recMsgKeys:
		var p struct {
			ID  string
			Ref blobRef
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.messages[p.ID]; m != nil {
			m.KeyRefs = append(m.KeyRefs, p.Ref)
		}
	case recMsgDelete:
		var p struct{ ID string }
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.messages[p.ID]; m != nil {
			m.Deleted = true
			m.Body, m.Header, m.KeyRefs = blobRef{}, blobRef{}, nil
		}
	case recMsgEdit:
		var p struct {
			ID           string
			Body, Header blobRef
			Keys         blobRef
			At           int64
		}
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		if m := s.messages[p.ID]; m != nil {
			m.Body, m.Header, m.EditedAt = p.Body, p.Header, p.At
			m.KeyRefs = nil
			if !p.Keys.empty() {
				m.KeyRefs = []blobRef{p.Keys}
			}
		}
	}
	return nil
}

func (s *Store) addMemberIndex(channelID string, m *memberRec) {
	if s.members[channelID] == nil {
		s.members[channelID] = map[string]*memberRec{}
	}
	s.members[channelID][m.UserID] = m
	if s.userChannels[m.UserID] == nil {
		s.userChannels[m.UserID] = map[string]bool{}
	}
	s.userChannels[m.UserID][channelID] = true
}

func (s *Store) removeMemberIndex(channelID, userID string) {
	delete(s.members[channelID], userID)
	delete(s.userChannels[userID], channelID)
}

func (s *Store) indexMessage(m *msgRec) {
	s.messages[m.ID] = m
	list := s.channelMsgs[m.ChannelID]
	// Appends are almost always already in order; the loop only pays off on
	// the rare out-of-order replay.
	if n := len(list); n == 0 || list[n-1].Seq < m.Seq {
		s.channelMsgs[m.ChannelID] = append(list, m)
		return
	}
	i := sort.Search(len(list), func(i int) bool { return list[i].Seq >= m.Seq })
	list = append(list, nil)
	copy(list[i+1:], list[i:])
	list[i] = m
	s.channelMsgs[m.ChannelID] = list
}

// ---------------------------------------------------------------- upkeep

func (s *Store) flushLoop() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-s.stopFlush:
			return
		case <-t.C:
			s.flushSeen()
		}
	}
}

// flushSeen persists "last seen" timestamps in batches. Writing one log record
// per HTTP request just to bump a clock would be the fastest way to turn a chat
// server into a disk-bound one.
func (s *Store) flushSeen() {
	s.mu.Lock()
	pending := make(map[string]int64, len(s.seenDirty))
	for id := range s.seenDirty {
		if u := s.users[id]; u != nil {
			pending[id] = u.LastSeenAt
		}
	}
	s.seenDirty = map[string]bool{}
	s.mu.Unlock()

	for id, at := range pending {
		_ = s.w.append(recUserSeen, map[string]any{"ID": id, "At": at})
	}
}

func (s *Store) garbageRatio() float64 {
	if s.w.liveBytes == 0 {
		return 0
	}
	deleted := 0
	for _, m := range s.messages {
		if m.Deleted {
			deleted++
		}
	}
	if len(s.messages) == 0 {
		return 0
	}
	return float64(deleted) / float64(len(s.messages))
}

// Compact rewrites both files from the live state, dropping superseded records
// and the blobs of deleted messages. It is safe to call while serving: writers
// block for the duration, readers do not.
func (s *Store) Compact() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.rewrite(func(add func(recordType, any) error, put func([]byte) (blobRef, error)) error {
		for _, u := range s.users {
			if err := add(recUser, u); err != nil {
				return err
			}
		}
		for id, up := range s.uploads {
			bytes, err := s.w.getBlob(up.Ref)
			if err != nil {
				return err
			}
			ref, err := put(bytes)
			if err != nil {
				return err
			}
			moved := *up
			moved.Ref = ref
			if err := add(recUpload, &moved); err != nil {
				return err
			}
			*s.uploads[id] = moved
		}
		for _, d := range s.devices {
			if err := add(recDevice, d); err != nil {
				return err
			}
			if d.Revoked {
				if err := add(recDeviceRevk, map[string]string{"ID": d.ID}); err != nil {
					return err
				}
			}
		}
		for devID, keys := range s.prekeys {
			live := make([]*preKeyRec, 0, len(keys))
			for _, k := range keys {
				if !k.Used {
					live = append(live, k)
				}
			}
			if len(live) == 0 {
				continue
			}
			if err := add(recPreKeyAdd, map[string]any{"DeviceID": devID, "Keys": live}); err != nil {
				return err
			}
		}
		for hash, sess := range s.sessions {
			if err := add(recSession, map[string]any{"Hash": hash, "Sess": sess}); err != nil {
				return err
			}
		}
		for _, c := range s.channels {
			if err := add(recChannel, c); err != nil {
				return err
			}
			for _, m := range s.members[c.ID] {
				if err := add(recMemberAdd, map[string]any{"ChannelID": c.ID, "M": m}); err != nil {
					return err
				}
			}
		}
		for _, list := range s.channelMsgs {
			for _, m := range list {
				if m.Deleted {
					continue
				}
				body, err := s.w.getBlob(m.Body)
				if err != nil {
					return err
				}
				header, err := s.w.getBlob(m.Header)
				if err != nil {
					return err
				}
				keys, err := s.mergedKeysLocked(m)
				if err != nil {
					return err
				}
				nm := *m
				if nm.Body, err = put(body); err != nil {
					return err
				}
				if nm.Header, err = put(header); err != nil {
					return err
				}
				packed, err := json.Marshal(keys)
				if err != nil {
					return err
				}
				ref, err := put(packed)
				if err != nil {
					return err
				}
				nm.KeyRefs = nil
				if !ref.empty() {
					nm.KeyRefs = []blobRef{ref}
				}
				if err := add(recMessage, &nm); err != nil {
					return err
				}
				*m = nm
			}
		}
		return nil
	})
}

func (s *Store) mergedKeysLocked(m *msgRec) (map[string]string, error) {
	out := map[string]string{}
	for _, ref := range m.KeyRefs {
		raw, err := s.w.getBlob(ref)
		if err != nil {
			return nil, err
		}
		var part map[string]string
		if err := json.Unmarshal(raw, &part); err != nil {
			continue
		}
		for k, v := range part {
			out[k] = v
		}
	}
	return out, nil
}

func encodeKeys(wrapped map[string][]byte) ([]byte, error) {
	if len(wrapped) == 0 {
		return nil, nil
	}
	enc := make(map[string]string, len(wrapped))
	for dev, key := range wrapped {
		enc[dev] = base64.StdEncoding.EncodeToString(key)
	}
	return json.Marshal(enc)
}

func lowerTrim(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

var _ = context.Background
