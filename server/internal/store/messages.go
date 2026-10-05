package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"sort"
	"time"
)

// InsertMessage writes the ciphertext, the opaque header and one wrapped
// content key per recipient device. Order matters: the blobs land first, so a
// crash can leave an orphan blob (harmless, reclaimed on compaction) but never
// a message whose key material is missing.
func (s *Store) InsertMessage(_ context.Context, m *Message, wrapped map[string][]byte) error {
	bodyRef, err := s.w.putBlob(m.Body)
	if err != nil {
		return err
	}
	headerRef, err := s.w.putBlob(m.Header)
	if err != nil {
		return err
	}
	packed, err := encodeKeys(wrapped)
	if err != nil {
		return err
	}
	keysRef, err := s.w.putBlob(packed)
	if err != nil {
		return err
	}

	s.mu.Lock()
	c, ok := s.channels[m.ChannelID]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	c.LastSeq++
	m.Seq = c.LastSeq
	m.CreatedAt = now()
	c.LastMsgAt = m.CreatedAt

	rec := &msgRec{
		ID: m.ID, ChannelID: m.ChannelID, Seq: m.Seq, SenderID: m.SenderID,
		SenderDevice: m.SenderDevice, Suite: m.Suite, Kind: m.Kind, ReplyTo: m.ReplyTo,
		CreatedAt: m.CreatedAt, Body: bodyRef, Header: headerRef,
		Attachments: m.Attachments,
	}
	if !keysRef.empty() {
		rec.KeyRefs = []blobRef{keysRef}
	}
	s.indexMessage(rec)
	if mem := s.members[m.ChannelID][m.SenderID]; mem != nil {
		mem.LastReadSeq = m.Seq // you have read what you just sent
	}
	seq, lastAt, sender := m.Seq, m.CreatedAt, m.SenderID
	s.mu.Unlock()

	if err := s.w.append(recMessage, rec); err != nil {
		return err
	}
	if err := s.w.append(recMemberRead, map[string]any{
		"ChannelID": m.ChannelID, "UserID": sender, "Seq": seq,
	}); err != nil {
		return err
	}
	_ = lastAt
	return nil
}

// History returns up to limit messages older than beforeSeq (0 = newest first),
// oldest-first, each carrying only the content key wrapped for deviceID. A
// device cannot download another device's key material through this call.
func (s *Store) History(_ context.Context, channelID, deviceID string, beforeSeq int64, limit int) ([]Message, error) {
	if beforeSeq <= 0 {
		beforeSeq = 1 << 62
	}
	s.mu.RLock()
	list := s.channelMsgs[channelID]
	hi := sort.Search(len(list), func(i int) bool { return list[i].Seq >= beforeSeq })
	lo := hi - limit
	if lo < 0 {
		lo = 0
	}
	window := make([]*msgRec, hi-lo)
	copy(window, list[lo:hi])
	s.mu.RUnlock()

	out := make([]Message, 0, len(window))
	for _, rec := range window {
		m, err := s.materialize(rec, deviceID)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, nil
}

func (s *Store) materialize(rec *msgRec, deviceID string) (*Message, error) {
	m := &Message{
		ID: rec.ID, ChannelID: rec.ChannelID, Seq: rec.Seq, SenderID: rec.SenderID,
		SenderDevice: rec.SenderDevice, Suite: rec.Suite, Kind: rec.Kind,
		ReplyTo: rec.ReplyTo, CreatedAt: rec.CreatedAt, EditedAt: rec.EditedAt,
		Deleted: rec.Deleted, Pinned: rec.Pinned, Attachments: rec.Attachments,
	}
	if rec.Deleted {
		return m, nil
	}
	body, err := s.w.getBlob(rec.Body)
	if err != nil {
		return nil, err
	}
	header, err := s.w.getBlob(rec.Header)
	if err != nil {
		return nil, err
	}
	m.Body, m.Header = body, header
	if deviceID == "" {
		return m, nil
	}
	// Later patches win, so a backfilled key overrides an older one.
	for i := len(rec.KeyRefs) - 1; i >= 0; i-- {
		raw, err := s.w.getBlob(rec.KeyRefs[i])
		if err != nil {
			return nil, err
		}
		var part map[string]string
		if err := json.Unmarshal(raw, &part); err != nil {
			continue
		}
		if enc, ok := part[deviceID]; ok {
			key, err := base64.StdEncoding.DecodeString(enc)
			if err == nil {
				m.WrappedKey = key
			}
			break
		}
	}
	return m, nil
}

func (s *Store) MessageForDevice(_ context.Context, messageID, deviceID string) (*Message, error) {
	s.mu.RLock()
	rec, ok := s.messages[messageID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	return s.materialize(rec, deviceID)
}

func (s *Store) LastMessage(ctx context.Context, channelID, deviceID string) (*Message, error) {
	msgs, err := s.History(ctx, channelID, deviceID, 0, 1)
	if err != nil || len(msgs) == 0 {
		return nil, err
	}
	return &msgs[0], nil
}

// DeleteMessage drops the wrapped keys along with the body. Without the keys
// the ciphertext is unrecoverable, so "delete for everyone" holds even against
// someone holding an old backup of the blob file.
func (s *Store) DeleteMessage(_ context.Context, messageID, requesterID string) error {
	s.mu.Lock()
	rec, ok := s.messages[messageID]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	if rec.SenderID != requesterID {
		s.mu.Unlock()
		return ErrDenied
	}
	rec.Deleted = true
	rec.Pinned = false
	rec.Body, rec.Header, rec.KeyRefs = blobRef{}, blobRef{}, nil
	s.mu.Unlock()
	return s.w.append(recMsgDelete, map[string]string{"ID": messageID})
}

func (s *Store) EditMessage(_ context.Context, messageID, requesterID string, header, body []byte, wrapped map[string][]byte) error {
	s.mu.RLock()
	rec, ok := s.messages[messageID]
	var sender string
	if ok {
		sender = rec.SenderID
	}
	s.mu.RUnlock()
	if !ok {
		return ErrNotFound
	}
	if sender != requesterID {
		return ErrDenied
	}

	bodyRef, err := s.w.putBlob(body)
	if err != nil {
		return err
	}
	headerRef, err := s.w.putBlob(header)
	if err != nil {
		return err
	}
	packed, err := encodeKeys(wrapped)
	if err != nil {
		return err
	}
	keysRef, err := s.w.putBlob(packed)
	if err != nil {
		return err
	}
	at := now()

	s.mu.Lock()
	rec.Body, rec.Header, rec.EditedAt = bodyRef, headerRef, at
	rec.KeyRefs = nil
	if !keysRef.empty() {
		rec.KeyRefs = []blobRef{keysRef}
	}
	s.mu.Unlock()

	return s.w.append(recMsgEdit, map[string]any{
		"ID": messageID, "Body": bodyRef, "Header": headerRef, "Keys": keysRef, "At": at,
	})
}

// BackfillKeys lets one device of a user grant history access to another device
// of the same user by re-wrapping content keys for it. The server only files
// what it is given; it never holds a key it could unwrap itself.
func (s *Store) BackfillKeys(_ context.Context, deviceID string, wrapped map[string][]byte) error {
	if len(wrapped) == 0 {
		return nil
	}
	// Group by message: one blob and one log record per message.
	for msgID, key := range wrapped {
		s.mu.RLock()
		rec, ok := s.messages[msgID]
		s.mu.RUnlock()
		if !ok || rec.Deleted {
			continue
		}
		packed, err := encodeKeys(map[string][]byte{deviceID: key})
		if err != nil {
			return err
		}
		ref, err := s.w.putBlob(packed)
		if err != nil {
			return err
		}
		s.mu.Lock()
		rec.KeyRefs = append(rec.KeyRefs, ref)
		s.mu.Unlock()
		if err := s.w.append(recMsgKeys, map[string]any{"ID": msgID, "Ref": ref}); err != nil {
			return err
		}
	}
	return nil
}

// SetPinned marks a message as pinned for everyone in the channel. Pinning is
// channel-wide rather than personal on purpose: a pinned message is how a group
// says "read this first", which only works if everyone sees the same one.
func (s *Store) SetPinned(_ context.Context, messageID string, pinned bool) error {
	s.mu.Lock()
	rec, ok := s.messages[messageID]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	if rec.Deleted {
		s.mu.Unlock()
		return ErrNotFound
	}
	rec.Pinned = pinned
	s.mu.Unlock()
	return s.w.append(recMsgPin, map[string]any{"ID": messageID, "Pinned": pinned})
}

// PinnedMessages returns the channel's pinned messages, oldest first, each with
// the key wrapped for the asking device.
func (s *Store) PinnedMessages(_ context.Context, channelID, deviceID string) ([]Message, error) {
	s.mu.RLock()
	var recs []*msgRec
	for _, m := range s.channelMsgs[channelID] {
		if m.Pinned && !m.Deleted {
			recs = append(recs, m)
		}
	}
	s.mu.RUnlock()

	out := make([]Message, 0, len(recs))
	for _, rec := range recs {
		m, err := s.materialize(rec, deviceID)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, nil
}

// AttachmentsOf lists the upload ids a message refers to, used when a message
// is deleted so its files go with it.
func (s *Store) AttachmentsOf(_ context.Context, messageID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if rec, ok := s.messages[messageID]; ok {
		return append([]string(nil), rec.Attachments...)
	}
	return nil
}

// dayBuckets returns the timestamp of local midnight `days-1` days ago, plus a
// function mapping a timestamp to its column.
//
// Buckets are calendar days, not rolling 24-hour windows. That distinction is
// the whole reason this helper exists: with rolling windows a message sent a
// minute ago lands in yesterday's column, because "now minus six days" is not
// a midnight. The chart labels are calendar days, so the counts must be too.
func dayBuckets(days int, nowMs int64) (int64, func(int64) int) {
	now := time.UnixMilli(nowMs)
	loc := now.Location()
	startOfToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	first := startOfToday.AddDate(0, 0, -(days - 1))
	firstMs := first.UnixMilli()

	return firstMs, func(ts int64) int {
		if ts < firstMs {
			return -1
		}
		// Round the timestamp down to its own local midnight, then count whole
		// days. Rounding first (instead of dividing the raw difference by
		// 86_400_000) is what keeps this correct across a DST change, where a
		// local day is 23 or 25 hours long.
		t := time.UnixMilli(ts).In(loc)
		midnight := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		d := int(midnight.Sub(first).Hours()/24 + 0.5)
		if d < 0 || d >= days {
			return -1
		}
		return d
	}
}

// MessagesPerDay buckets message counts for the admin chart. Counting from the
// in-memory index costs nothing and avoids keeping a second set of counters
// that could drift from reality.
func (s *Store) MessagesPerDay(days int, nowMs int64) []int {
	out := make([]int, days)
	_, bucketOf := dayBuckets(days, nowMs)

	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, m := range s.messages {
		if b := bucketOf(m.CreatedAt); b >= 0 {
			out[b]++
		}
	}
	return out
}

// RegistrationsPerDay is the same shape for the sign-up series.
func (s *Store) RegistrationsPerDay(days int, nowMs int64) []int {
	out := make([]int, days)
	_, bucketOf := dayBuckets(days, nowMs)

	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.users {
		if b := bucketOf(u.CreatedAt); b >= 0 {
			out[b]++
		}
	}
	return out
}

// CountMessagesIn is the per-channel total shown in the admin table.
func (s *Store) CountMessagesIn(channelID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.channelMsgs[channelID])
}

func (s *Store) CountAllDevices() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, d := range s.devices {
		if !d.Revoked {
			n++
		}
	}
	return n
}

// ExpireMessages burns everything past its deadline and returns how many.
//
// Two deadlines apply, and the earlier one wins: a chat's own timer (set by its
// members) and the installation-wide retention limit (set by the operator).
// Neither hides a message — both destroy the wrapped content keys, exactly the
// way "delete for everyone" does, so a message that has expired is unreadable
// even to someone holding an old copy of the blob file.
//
// The channels it touched come back so the caller can tell those chats to
// reload; a client showing messages that no longer have keys anywhere looks
// like the app losing data rather than a timer doing its job.
func (s *Store) ExpireMessages(nowMs int64, globalTTLSeconds int64) (int, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	type doomed struct {
		id        string
		channelID string
		uploads   []string
	}
	var hits []doomed

	for id, rec := range s.messages {
		if rec.Deleted {
			continue
		}
		ttl := globalTTLSeconds
		if c := s.channels[rec.ChannelID]; c != nil && c.TTLSeconds > 0 {
			if ttl == 0 || c.TTLSeconds < ttl {
				ttl = c.TTLSeconds
			}
		}
		if ttl <= 0 {
			continue
		}
		if rec.CreatedAt+ttl*1000 > nowMs {
			continue
		}
		hits = append(hits, doomed{id: id, channelID: rec.ChannelID, uploads: append([]string(nil), rec.Attachments...)})
	}

	touched := map[string]bool{}
	for _, d := range hits {
		rec := s.messages[d.id]
		if rec == nil {
			continue
		}
		rec.Deleted = true
		rec.Pinned = false
		rec.Body, rec.Header, rec.KeyRefs = blobRef{}, blobRef{}, nil
		rec.Attachments = nil
		touched[d.channelID] = true
		_ = s.w.append(recMsgDelete, map[string]string{"ID": d.id})
		for _, up := range d.uploads {
			if _, ok := s.uploads[up]; ok {
				delete(s.uploads, up)
				_ = s.w.append(recUploadDel, map[string]string{"ID": up})
			}
		}
	}

	channels := make([]string, 0, len(touched))
	for id := range touched {
		channels = append(channels, id)
	}
	return len(hits), channels
}
