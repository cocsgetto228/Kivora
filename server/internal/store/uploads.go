package store

import (
	"context"
	"errors"
	"strings"
)

// uploadRec is an upload's metadata plus where its bytes live. The bytes
// themselves are never parsed here: for an encrypted channel they are
// ciphertext, and the server has no key.
type uploadRec struct {
	Meta Upload  `json:"m"`
	Ref  blobRef `json:"r"`
}

var ErrTooLarge = errors.New("upload too large")

// PutUpload stores bytes and returns the metadata. `kind` is "media" for
// message attachments and "avatar" for profile pictures — avatars are stored
// in the clear on purpose (they are shown in lists before any chat is opened),
// and that difference is recorded here rather than inferred later.
func (s *Store) PutUpload(_ context.Context, meta Upload, data []byte) (*Upload, error) {
	ref, err := s.w.putBlob(data)
	if err != nil {
		return nil, err
	}
	meta.Size = int64(len(data))
	meta.CreatedAt = now()
	rec := &uploadRec{Meta: meta, Ref: ref}

	s.mu.Lock()
	s.uploads[meta.ID] = rec
	s.mu.Unlock()

	if err := s.w.append(recUpload, rec); err != nil {
		return nil, err
	}
	out := rec.Meta
	return &out, nil
}

func (s *Store) UploadMeta(_ context.Context, id string) (*Upload, error) {
	s.mu.RLock()
	rec, ok := s.uploads[id]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrNotFound
	}
	out := rec.Meta
	return &out, nil
}

func (s *Store) UploadBytes(_ context.Context, id string) (*Upload, []byte, error) {
	s.mu.RLock()
	rec, ok := s.uploads[id]
	s.mu.RUnlock()
	if !ok {
		return nil, nil, ErrNotFound
	}
	data, err := s.w.getBlob(rec.Ref)
	if err != nil {
		return nil, nil, err
	}
	meta := rec.Meta
	return &meta, data, nil
}

func (s *Store) DeleteUpload(_ context.Context, id string) error {
	s.mu.Lock()
	_, existed := s.uploads[id]
	delete(s.uploads, id)
	s.mu.Unlock()
	if !existed {
		return nil
	}
	return s.w.append(recUploadDel, map[string]string{"ID": id})
}

// UploadsBytesTotal is what the admin overview reports as disk used by files.
func (s *Store) UploadsBytesTotal() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var total int64
	for _, u := range s.uploads {
		total += u.Meta.Size
	}
	return total
}

// AvatarMime keeps the set of image types an avatar may be. Anything outside
// it is refused: an avatar is rendered by every client that sees the user, so
// it is the wrong place to accept arbitrary bytes with a claimed type.
func AvatarMimeAllowed(mime string) bool {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

// MediaMimeAllowed is deliberately broader — the bytes are ciphertext, and the
// declared type is only a hint the sending client chose to reveal.
func MediaMimeAllowed(mime string) bool {
	m := strings.ToLower(strings.TrimSpace(mime))
	if m == "" {
		return false
	}
	if len(m) > 128 || strings.ContainsAny(m, "\r\n\"<>") {
		return false
	}
	// Refuse anything a browser might be tempted to execute if it were ever
	// served with the wrong headers.
	switch {
	case strings.HasPrefix(m, "text/html"),
		strings.Contains(m, "javascript"),
		strings.Contains(m, "xhtml"),
		strings.Contains(m, "svg"):
		return false
	}
	return strings.Contains(m, "/")
}
