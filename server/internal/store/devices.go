package store

import "context"

// ---------------------------------------------------------------- devices

func (s *Store) CreateDevice(_ context.Context, d *Device) error {
	d.CreatedAt = now()
	d.LastSeenAt = d.CreatedAt
	cp := *d
	s.mu.Lock()
	s.devices[d.ID] = &cp
	s.devicesByUser[d.UserID] = append(s.devicesByUser[d.UserID], d.ID)
	s.mu.Unlock()
	return s.w.append(recDevice, &cp)
}

func (s *Store) DeviceByID(_ context.Context, id string) (*Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *d
	return &cp, nil
}

func (s *Store) DevicesForUser(_ context.Context, userID string) ([]Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.devicesForUserLocked(userID), nil
}

func (s *Store) devicesForUserLocked(userID string) []Device {
	out := []Device{}
	for _, id := range s.devicesByUser[userID] {
		d := s.devices[id]
		if d == nil || d.Revoked {
			continue
		}
		out = append(out, *d)
	}
	return out
}

// DevicesForChannel is the set a sender must wrap the content key for: every
// live device of every member.
func (s *Store) DevicesForChannel(_ context.Context, channelID string) ([]Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []Device{}
	for uid := range s.members[channelID] {
		out = append(out, s.devicesForUserLocked(uid)...)
	}
	return out, nil
}

func (s *Store) RevokeDevice(_ context.Context, userID, deviceID string) error {
	s.mu.Lock()
	d, ok := s.devices[deviceID]
	if !ok || d.UserID != userID {
		s.mu.Unlock()
		return ErrNotFound
	}
	d.Revoked = true
	gone := s.deleteSessionsForDeviceLocked(deviceID)
	s.mu.Unlock()

	if err := s.w.append(recDeviceRevk, map[string]string{"ID": deviceID}); err != nil {
		return err
	}
	for _, h := range gone {
		if err := s.w.append(recSessionDel, map[string]string{"Hash": h}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) TouchDevice(_ context.Context, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.devices[id]; ok {
		d.LastSeenAt = now()
	}
}

func (s *Store) CountDevices(_ context.Context, userID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.devicesForUserLocked(userID)), nil
}

// ---------------------------------------------------------------- prekeys

func (s *Store) AddPreKeys(_ context.Context, deviceID string, ids []string, keys [][]byte) error {
	if len(ids) == 0 {
		return nil
	}
	recs := make([]*preKeyRec, 0, len(ids))
	for i := range ids {
		recs = append(recs, &preKeyRec{ID: ids[i], Pub: keys[i]})
	}
	s.mu.Lock()
	s.prekeys[deviceID] = append(s.prekeys[deviceID], recs...)
	s.mu.Unlock()
	return s.w.append(recPreKeyAdd, map[string]any{"DeviceID": deviceID, "Keys": recs})
}

// TakePreKey consumes one unused one-time prekey. Running out is not an error:
// the handshake falls back to the signed prekey, trading a little forward
// secrecy for availability — the same choice X3DH makes.
func (s *Store) TakePreKey(_ context.Context, deviceID string) (string, []byte, error) {
	s.mu.Lock()
	var picked *preKeyRec
	for _, k := range s.prekeys[deviceID] {
		if !k.Used {
			k.Used = true
			picked = k
			break
		}
	}
	s.mu.Unlock()
	if picked == nil {
		return "", nil, nil
	}
	if err := s.w.append(recPreKeyUse, map[string]string{"DeviceID": deviceID, "ID": picked.ID}); err != nil {
		return "", nil, err
	}
	return picked.ID, picked.Pub, nil
}

func (s *Store) CountPreKeys(_ context.Context, deviceID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, k := range s.prekeys[deviceID] {
		if !k.Used {
			n++
		}
	}
	return n, nil
}
