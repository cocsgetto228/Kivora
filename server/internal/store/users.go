package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------- users

func (s *Store) CreateUser(_ context.Context, u *User) error {
	u.Username = lowerTrim(u.Username)
	u.CreatedAt = now()
	s.mu.Lock()
	if _, taken := s.byUsername[u.Username]; taken {
		s.mu.Unlock()
		return ErrConflict
	}
	cp := *u
	s.users[u.ID] = &cp
	s.byUsername[u.Username] = u.ID
	s.mu.Unlock()
	return s.w.append(recUser, &cp)
}

func (s *Store) UserByUsername(_ context.Context, username string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.byUsername[lowerTrim(username)]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *s.users[id]
	return &cp, nil
}

func (s *Store) UserByID(_ context.Context, id string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (s *Store) CountUsers(_ context.Context) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users), nil
}

// TouchUser only writes to memory; flushSeen persists it in batches.
func (s *Store) TouchUser(_ context.Context, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.users[id]; ok {
		u.LastSeenAt = now()
		s.seenDirty[id] = true
	}
}

func (s *Store) UpdateProfile(_ context.Context, id, displayName, bio, avatar string) error {
	s.mu.Lock()
	u, ok := s.users[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	u.DisplayName, u.Bio, u.Avatar = displayName, bio, avatar
	s.mu.Unlock()
	return s.w.append(recUserUpdate, map[string]string{
		"ID": id, "DisplayName": displayName, "Bio": bio, "Avatar": avatar,
	})
}

// SetUserFlags is the administrator's lever: promote, demote, suspend. A
// suspended account keeps its data but cannot authenticate, and its live
// sessions are dropped — a suspension that leaves a valid token behind is not
// a suspension.
func (s *Store) SetUserFlags(_ context.Context, id string, isAdmin, suspended bool) error {
	s.mu.Lock()
	u, ok := s.users[id]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	u.IsAdmin, u.Suspended = isAdmin, suspended
	var gone []string
	if suspended {
		for hash, sess := range s.sessions {
			if sess.UserID == id {
				gone = append(gone, hash)
				delete(s.sessions, hash)
			}
		}
	}
	s.mu.Unlock()

	if err := s.w.append(recUserFlags, map[string]any{
		"ID": id, "IsAdmin": isAdmin, "Suspended": suspended,
	}); err != nil {
		return err
	}
	for _, h := range gone {
		if err := s.w.append(recSessionDel, map[string]string{"Hash": h}); err != nil {
			return err
		}
	}
	return nil
}

// AllUsers backs the admin table, newest first.
func (s *Store) AllUsers(_ context.Context) []User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]User, 0, len(s.users))
	for _, u := range s.users {
		out = append(out, *u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// CountAdmins exists so the last administrator cannot demote or suspend
// themselves and lock everyone out of the server.
func (s *Store) CountAdmins(_ context.Context) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, u := range s.users {
		if u.IsAdmin && !u.Suspended {
			n++
		}
	}
	return n
}

func (s *Store) SearchUsers(_ context.Context, q string, limit int) ([]Member, error) {
	needle := lowerTrim(q)
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Member{}
	for _, u := range s.users {
		if !strings.Contains(u.Username, needle) && !strings.Contains(strings.ToLower(u.DisplayName), needle) {
			continue
		}
		out = append(out, Member{
			UserID: u.ID, Username: u.Username, DisplayName: u.DisplayName,
			AvatarHue: u.AvatarHue, Avatar: u.Avatar, Role: "member", LastSeenAt: u.LastSeenAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ---------------------------------------------------------------- sessions

func (s *Store) CreateSession(_ context.Context, tokenHash, userID, deviceID, ua string, ttl time.Duration) error {
	sess := Session{UserID: userID, DeviceID: deviceID, ExpiresAt: time.Now().Add(ttl).UnixMilli()}
	s.mu.Lock()
	s.sessions[tokenHash] = &sess
	s.mu.Unlock()
	return s.w.append(recSession, map[string]any{"Hash": tokenHash, "Sess": sess})
}

func (s *Store) SessionByHash(_ context.Context, tokenHash string) (*Session, error) {
	s.mu.RLock()
	sess, ok := s.sessions[tokenHash]
	var cp Session
	if ok {
		cp = *sess
	}
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	if cp.ExpiresAt < now() {
		_ = s.DeleteSession(context.Background(), tokenHash)
		return nil, ErrNotFound
	}
	return &cp, nil
}

func (s *Store) DeleteSession(_ context.Context, tokenHash string) error {
	s.mu.Lock()
	_, existed := s.sessions[tokenHash]
	delete(s.sessions, tokenHash)
	s.mu.Unlock()
	if !existed {
		return nil
	}
	return s.w.append(recSessionDel, map[string]string{"Hash": tokenHash})
}

func (s *Store) BindSessionDevice(_ context.Context, tokenHash, deviceID string) error {
	s.mu.Lock()
	sess, ok := s.sessions[tokenHash]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	sess.DeviceID = deviceID
	s.mu.Unlock()
	return s.w.append(recSessionBind, map[string]string{"Hash": tokenHash, "DeviceID": deviceID})
}

func (s *Store) DeleteExpiredSessions(_ context.Context) (int64, error) {
	s.mu.Lock()
	expired := s.dropExpiredSessionsLocked()
	s.mu.Unlock()
	for _, h := range expired {
		if err := s.w.append(recSessionDel, map[string]string{"Hash": h}); err != nil {
			return 0, err
		}
	}
	return int64(len(expired)), nil
}

func (s *Store) dropExpiredSessionsLocked() []string {
	cutoff := now()
	var gone []string
	for hash, sess := range s.sessions {
		if sess.ExpiresAt < cutoff {
			gone = append(gone, hash)
			delete(s.sessions, hash)
		}
	}
	return gone
}

// deleteSessionsForDevice is called when a device is revoked: the point of
// revocation is that the device stops being able to read anything, and a live
// bearer token would undo that.
func (s *Store) deleteSessionsForDeviceLocked(deviceID string) []string {
	var gone []string
	for hash, sess := range s.sessions {
		if sess.DeviceID == deviceID {
			gone = append(gone, hash)
			delete(s.sessions, hash)
		}
	}
	return gone
}
