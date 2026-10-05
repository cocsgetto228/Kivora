package api

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/store"
)

// Uploads arrive as raw bytes, not as JSON or multipart.
//
// A 20 MB video base64-encoded inside JSON is 27 MB on the wire and has to be
// decoded into a second copy in memory; multipart parsing has the same problem
// with extra parsing surface. The metadata that would live in the form fields
// goes in the query string instead, which the client already controls.
//
// For an encrypted channel the body is ciphertext produced by the sender's
// cipher suite. The server stores the bytes, records the size, and never looks
// inside.

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	channelID := r.URL.Query().Get("channel")
	if channelID == "" {
		fail(w, http.StatusBadRequest, "missing_channel")
		return
	}
	member, err := s.st.IsMember(r.Context(), channelID, userID(r))
	if err != nil || !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}

	mime := r.URL.Query().Get("mime")
	if !store.MediaMimeAllowed(mime) {
		fail(w, http.StatusBadRequest, "unsupported_media")
		return
	}

	data, err := readBody(r, s.cfg.MaxFileBytes)
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "upload_too_large")
		return
	}
	if len(data) == 0 {
		fail(w, http.StatusBadRequest, "empty_upload")
		return
	}

	meta, err := s.st.PutUpload(r.Context(), store.Upload{
		ID:        auth.NewID("f"),
		OwnerID:   userID(r),
		ChannelID: channelID,
		Kind:      "media",
		Mime:      mime,
		Width:     intQueryValue(r, "w", 0, 20000),
		Height:    intQueryValue(r, "h", 0, 20000),
		Duration:  intQueryValue(r, "d", 0, 86400),
	}, data)
	if err != nil {
		s.log.Error("upload", "err", err)
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload": meta})
}

// handleDownload streams an upload back to a member of its channel. The
// response is marked non-executable and non-sniffable: these bytes are usually
// ciphertext, but if a client ever fetched one directly the browser must not be
// tempted to run it.
func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	meta, err := s.st.UploadMeta(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if meta.Kind != "media" {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	member, err := s.st.IsMember(r.Context(), meta.ChannelID, userID(r))
	if err != nil || !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	_, data, err := s.st.UploadBytes(r.Context(), meta.ID)
	if mapStoreErr(w, err) {
		return
	}

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("Content-Disposition", "attachment")
	h.Set("X-Content-Type-Options", "nosniff")
	// Ciphertext for a given id never changes, so it can be cached hard.
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// handleAvatarUpload takes a *plaintext* image.
//
// This is the one place Kivora stores user content the server can read, and it
// is a deliberate trade: an avatar is shown in the chat list before any
// conversation is opened, by every member of every shared channel, on devices
// that may hold no key for that person yet. Encrypting it would mean either
// wrapping it for every device of every possible viewer or inventing a second
// key hierarchy for identity. Neither is worth it for a picture the user chose
// to publish. docs/CRYPTO.md says so out loud rather than leaving it implied.
func (s *Server) handleAvatarUpload(w http.ResponseWriter, r *http.Request) {
	mime := r.URL.Query().Get("mime")
	if !store.AvatarMimeAllowed(mime) {
		fail(w, http.StatusBadRequest, "unsupported_media")
		return
	}
	data, err := readBody(r, s.cfg.MaxAvatarBytes)
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "upload_too_large")
		return
	}
	if !looksLikeImage(data, mime) {
		fail(w, http.StatusBadRequest, "unsupported_media")
		return
	}

	meta, err := s.st.PutUpload(r.Context(), store.Upload{
		ID:      auth.NewID("a"),
		OwnerID: userID(r),
		Kind:    "avatar",
		Mime:    mime,
	}, data)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upload": meta})
}

// handleAvatar serves an avatar to any signed-in user. It is not public: an
// unauthenticated endpoint would let anyone enumerate the server's members.
func (s *Server) handleAvatar(w http.ResponseWriter, r *http.Request) {
	meta, data, err := s.st.UploadBytes(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if meta.Kind != "avatar" {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	h := w.Header()
	h.Set("Content-Type", meta.Mime)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; sandbox")
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func readBody(r *http.Request, limit int64) ([]byte, error) {
	return io.ReadAll(io.LimitReader(r.Body, limit+1))
}

func intQueryValue(r *http.Request, key string, def, max int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// looksLikeImage checks the magic bytes against the declared type. A client
// that claims image/png and uploads something else gets refused here rather
// than in every viewer that later renders it.
func looksLikeImage(data []byte, mime string) bool {
	if len(data) < 12 {
		return false
	}
	switch strings.ToLower(mime) {
	case "image/png":
		return string(data[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		return data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF
	case "image/gif":
		return string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"
	case "image/webp":
		return string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	default:
		return false
	}
}
