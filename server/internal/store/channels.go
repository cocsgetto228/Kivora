package store

import (
	"context"
	"sort"
	"strings"
)

func (s *Store) CreateChannel(_ context.Context, c *Channel, memberIDs []string) error {
	c.CreatedAt = now()
	cp := *c
	cp.Members = nil

	s.mu.Lock()
	if cp.Slug != "" {
		if _, taken := s.channelsBySlug[cp.Slug]; taken {
			s.mu.Unlock()
			return ErrConflict
		}
	}
	s.channels[cp.ID] = &cp
	if cp.Slug != "" {
		s.channelsBySlug[cp.Slug] = cp.ID
	}
	recs := make([]*memberRec, 0, len(memberIDs))
	for _, uid := range memberIDs {
		role := "member"
		if uid == cp.OwnerID {
			role = "owner"
		}
		m := &memberRec{UserID: uid, Role: role, JoinedAt: cp.CreatedAt}
		s.addMemberIndex(cp.ID, m)
		recs = append(recs, m)
	}
	s.mu.Unlock()

	if err := s.w.append(recChannel, &cp); err != nil {
		return err
	}
	for _, m := range recs {
		if err := s.w.append(recMemberAdd, map[string]any{"ChannelID": cp.ID, "M": m}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ChannelByID(_ context.Context, id string) (*Channel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.channels[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *c
	cp.Members = nil
	return &cp, nil
}

func (s *Store) ChannelBySlug(_ context.Context, slug string) (*Channel, error) {
	s.mu.RLock()
	id, ok := s.channelsBySlug[slug]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	return s.ChannelByID(context.Background(), id)
}

// DirectChannelBetween keeps "open a DM" idempotent.
func (s *Store) DirectChannelBetween(_ context.Context, a, b string) (*Channel, error) {
	wantSize := 2
	if a == b {
		wantSize = 1 // saved messages
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for chID := range s.userChannels[a] {
		c := s.channels[chID]
		if c == nil || c.Kind != "dm" {
			continue
		}
		mm := s.members[chID]
		if len(mm) != wantSize {
			continue
		}
		if _, ok := mm[b]; !ok {
			continue
		}
		cp := *c
		cp.Members = nil
		return &cp, nil
	}
	return nil, ErrNotFound
}

func (s *Store) IsMember(_ context.Context, channelID, userID string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.members[channelID][userID]
	return ok, nil
}

func (s *Store) AddMember(_ context.Context, channelID, userID, role string) error {
	s.mu.Lock()
	if _, exists := s.members[channelID][userID]; exists {
		s.mu.Unlock()
		return nil
	}
	if _, ok := s.channels[channelID]; !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	m := &memberRec{UserID: userID, Role: role, JoinedAt: now()}
	s.addMemberIndex(channelID, m)
	s.mu.Unlock()
	return s.w.append(recMemberAdd, map[string]any{"ChannelID": channelID, "M": m})
}

func (s *Store) RemoveMember(_ context.Context, channelID, userID string) error {
	s.mu.Lock()
	_, existed := s.members[channelID][userID]
	s.removeMemberIndex(channelID, userID)
	s.mu.Unlock()
	if !existed {
		return nil
	}
	return s.w.append(recMemberDel, map[string]string{"ChannelID": channelID, "UserID": userID})
}

func (s *Store) MembersOf(_ context.Context, channelID string) ([]Member, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.membersOfLocked(channelID), nil
}

func (s *Store) membersOfLocked(channelID string) []Member {
	out := []Member{}
	for uid, m := range s.members[channelID] {
		u := s.users[uid]
		if u == nil {
			continue
		}
		out = append(out, Member{
			UserID: uid, Username: u.Username, DisplayName: u.DisplayName,
			AvatarHue: u.AvatarHue, Avatar: u.Avatar, Role: m.Role, LastSeenAt: u.LastSeenAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DisplayName < out[j].DisplayName })
	return out
}

func (s *Store) MemberIDs(_ context.Context, channelID string) ([]string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.members[channelID]))
	for uid := range s.members[channelID] {
		out = append(out, uid)
	}
	sort.Strings(out)
	return out, nil
}

// ChannelsForUser builds the sidebar in one pass: membership, unread counts and
// member lists, ordered by most recent activity.
func (s *Store) ChannelsForUser(_ context.Context, userID string) ([]Channel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Channel{}
	for chID := range s.userChannels[userID] {
		c := s.channels[chID]
		// Threads are listed inside their parent group, not in the sidebar.
		if c == nil || c.Kind == "thread" {
			continue
		}
		out = append(out, s.projectLocked(c, userID))
	}
	// Pinned chats float to the top; everything else is most-recent-first.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Pinned != out[j].Pinned {
			return out[i].Pinned
		}
		if out[i].LastMsgAt != out[j].LastMsgAt {
			return out[i].LastMsgAt > out[j].LastMsgAt
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})
	return out, nil
}

// projectLocked fills in the per-user view of a channel: unread count, the
// member's own flags, and the counts the sidebar shows.
func (s *Store) projectLocked(c *Channel, userID string) Channel {
	cp := *c
	if mem := s.members[c.ID][userID]; mem != nil {
		cp.LastReadSeq = mem.LastReadSeq
		if cp.LastSeq > mem.LastReadSeq {
			cp.Unread = cp.LastSeq - mem.LastReadSeq
		}
		cp.Archived, cp.Pinned, cp.Muted = mem.Archived, mem.Pinned, mem.Muted
	}
	cp.Members = s.membersOfLocked(c.ID)
	for _, other := range s.channels {
		if other.Kind == "thread" && other.ParentID == c.ID {
			if _, member := s.members[other.ID][userID]; member {
				cp.ThreadCount++
			}
		}
	}
	for _, m := range s.channelMsgs[c.ID] {
		if m.Pinned && !m.Deleted {
			cp.PinnedCount++
		}
	}
	return cp
}

// ThreadsOf lists the threads inside a group that this user actually holds
// keys for. Threads they were not given access to are not merely hidden from
// the list — they were never wrapped a key, so there is nothing to hide.
func (s *Store) ThreadsOf(_ context.Context, parentID, userID string) ([]Channel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Channel{}
	for _, c := range s.channels {
		if c.Kind != "thread" || c.ParentID != parentID {
			continue
		}
		if _, member := s.members[c.ID][userID]; !member {
			continue
		}
		out = append(out, s.projectLocked(c, userID))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

// SetMembershipFlags stores the per-person view of a chat: archived, pinned
// and muted are properties of the membership, not of the conversation, so one
// person archiving a group does not archive it for everyone.
func (s *Store) SetMembershipFlags(_ context.Context, channelID, userID string, archived, pinned, muted bool) error {
	s.mu.Lock()
	m := s.members[channelID][userID]
	if m == nil {
		s.mu.Unlock()
		return ErrNotFound
	}
	m.Archived, m.Pinned, m.Muted = archived, pinned, muted
	s.mu.Unlock()
	return s.w.append(recMemberFlags, map[string]any{
		"ChannelID": channelID, "UserID": userID,
		"Archived": archived, "Pinned": pinned, "Muted": muted,
	})
}

func (s *Store) MembershipFlags(_ context.Context, channelID, userID string) (archived, pinned, muted bool, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m := s.members[channelID][userID]
	if m == nil {
		return false, false, false, ErrNotFound
	}
	return m.Archived, m.Pinned, m.Muted, nil
}

func (s *Store) SetChannelAvatar(ctx context.Context, id, avatar string) error {
	s.mu.RLock()
	c, ok := s.channels[id]
	var name, topic string
	if ok {
		name, topic = c.Name, c.Topic
	}
	s.mu.RUnlock()
	if !ok {
		return ErrNotFound
	}
	return s.updateChannelMeta(ctx, id, name, topic, avatar)
}

// AllChannels backs the admin table.
func (s *Store) AllChannels(_ context.Context) []Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Channel, 0, len(s.channels))
	for id, c := range s.channels {
		cp := *c
		cp.Members = s.membersOfLocked(id)
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastMsgAt > out[j].LastMsgAt })
	return out
}

// PublicChannels is the Mattermost-style "browse channels" list.
func (s *Store) PublicChannels(_ context.Context, userID string) ([]Channel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Channel{}
	for id, c := range s.channels {
		if c.Kind != "channel" {
			continue
		}
		if s.userChannels[userID][id] {
			continue
		}
		cp := *c
		cp.Members = nil
		out = append(out, cp)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *Store) SetLastRead(_ context.Context, channelID, userID string, seq int64) error {
	s.mu.Lock()
	m := s.members[channelID][userID]
	if m == nil || m.LastReadSeq >= seq {
		s.mu.Unlock()
		return nil
	}
	m.LastReadSeq = seq
	s.mu.Unlock()
	return s.w.append(recMemberRead, map[string]any{"ChannelID": channelID, "UserID": userID, "Seq": seq})
}

func (s *Store) UpdateChannelMeta(ctx context.Context, id, name, topic string) error {
	s.mu.RLock()
	c, ok := s.channels[id]
	var avatar string
	if ok {
		avatar = c.Avatar
		if name == "" {
			name = c.Name
		}
	}
	s.mu.RUnlock()
	if !ok {
		return ErrNotFound
	}
	return s.updateChannelMeta(ctx, id, name, topic, avatar)
}

// updateChannelMeta writes the three mutable fields together, so replaying the
// log can never resurrect a stale avatar alongside a fresh name.
func (s *Store) updateChannelMeta(_ context.Context, id, name, topic, avatar string) error {
	s.mu.Lock()
	c, ok := s.channels[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	c.Name, c.Topic, c.Avatar = name, topic, avatar
	s.mu.Unlock()
	return s.w.append(recChannelMeta, map[string]string{
		"ID": id, "Name": name, "Topic": topic, "Avatar": avatar,
	})
}

// Slugify makes a URL-safe channel handle. Cyrillic is kept as-is rather than
// transliterated: a Russian-speaking team should get #общее, not #obshchee.
func Slugify(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r >= 'а' && r <= 'я', r == 'ё', r == '_':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// SetChannelTTL turns disappearing messages on or off for a chat.
//
// The timer belongs to the chat rather than to one person's view of it. A
// per-viewer timer would only hide messages from the person who set it, which
// is theatre: the copy that matters is the one on the other device.
func (s *Store) SetChannelTTL(_ context.Context, id string, ttlSeconds int64) error {
	if ttlSeconds < 0 {
		ttlSeconds = 0
	}
	s.mu.Lock()
	c, ok := s.channels[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	c.TTLSeconds = ttlSeconds
	s.mu.Unlock()
	return s.w.append(recChannelTTL, map[string]any{"ID": id, "TTL": ttlSeconds})
}
