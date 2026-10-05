package api

import (
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/suite"
)

type registerDeviceReq struct {
	Name            string `json:"name"`
	Platform        string `json:"platform"`
	Suite           string `json:"suite"`
	IdentityPub     string `json:"identityPub"`     // base64
	SignedPreKeyPub string `json:"signedPreKeyPub"` // base64
	SignedPreKeySig string `json:"signedPreKeySig"` // base64
	PreKeys         []struct {
		ID  string `json:"id"`
		Pub string `json:"pub"`
	} `json:"preKeys"`
}

// handleRegisterDevice publishes a device's *public* key material. The private
// halves are generated on the client and never transmitted; there is no code
// path in this server that could accept them.
func (s *Server) handleRegisterDevice(w http.ResponseWriter, r *http.Request) {
	var req registerDeviceReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := suite.Validate(req.Suite, s.cfg.SuiteAllowed); err != nil {
		fail(w, http.StatusBadRequest, "suite_rejected")
		return
	}
	n, err := s.st.CountDevices(r.Context(), userID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	if n >= s.cfg.MaxDevices {
		fail(w, http.StatusForbidden, "too_many_devices")
		return
	}

	idPub, err1 := b64(req.IdentityPub, 32, 2048)
	spkPub, err2 := b64(req.SignedPreKeyPub, 32, 2048)
	spkSig, err3 := b64(req.SignedPreKeySig, 32, 4096)
	if err1 != nil || err2 != nil || err3 != nil {
		fail(w, http.StatusBadRequest, "bad_key_material")
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "Unnamed device"
	}
	if len([]rune(name)) > 64 {
		name = string([]rune(name)[:64])
	}

	d := &store.Device{
		ID: auth.NewID("d"), UserID: userID(r), Name: name,
		Platform: sanitizePlatform(req.Platform), Suite: req.Suite,
		IdentityPub: idPub, SignedPreKeyPub: spkPub, SignedPreKeySig: spkSig,
	}
	if err := s.st.CreateDevice(r.Context(), d); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}

	if len(req.PreKeys) > 0 {
		ids := make([]string, 0, len(req.PreKeys))
		keys := make([][]byte, 0, len(req.PreKeys))
		for _, pk := range req.PreKeys {
			pub, err := b64(pk.Pub, 32, 2048)
			if err != nil {
				continue
			}
			// The id comes from the client: only the client knows which
			// private key it belongs to, and it never uploads that.
			id := sanitizeKeyID(pk.ID)
			if id == "" {
				continue
			}
			ids = append(ids, id)
			keys = append(keys, pub)
		}
		if err := s.st.AddPreKeys(r.Context(), d.ID, ids, keys); err != nil {
			s.log.Error("prekeys", "err", err)
		}
	}

	// Bind this session to the new device so wrapped keys can be addressed.
	if err := s.st.BindSessionDevice(r.Context(), auth.HashToken(s.cfg.SecretKey, tokenOf(r)), d.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": d})
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.st.DevicesForUser(r.Context(), userID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices, "current": deviceID(r)})
}

// handleAttachDevice binds an existing device to the current session. A user
// who signs in again on a machine that already holds its private keys keeps the
// same device identity instead of accumulating a new one per login — and the
// server only ever moves an id it has already verified belongs to this user.
func (s *Server) handleAttachDevice(w http.ResponseWriter, r *http.Request) {
	d, err := s.st.DeviceByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if d.UserID != userID(r) {
		fail(w, http.StatusForbidden, "not_your_device")
		return
	}
	if d.Revoked {
		fail(w, http.StatusForbidden, "device_revoked")
		return
	}
	if err := s.st.BindSessionDevice(r.Context(), auth.HashToken(s.cfg.SecretKey, tokenOf(r)), d.ID); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	left, _ := s.st.CountPreKeys(r.Context(), d.ID)
	writeJSON(w, http.StatusOK, map[string]any{"device": d, "preKeysAvailable": left})
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if mapStoreErr(w, s.st.RevokeDevice(r.Context(), userID(r), r.PathValue("id"))) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type preKeyUploadReq struct {
	PreKeys []struct {
		ID  string `json:"id"`
		Pub string `json:"pub"`
	} `json:"preKeys"`
}

// handleUploadPreKeys replenishes the one-time prekey pool. Clients call this
// when the server reports the pool running low.
func (s *Server) handleUploadPreKeys(w http.ResponseWriter, r *http.Request) {
	dev := deviceID(r)
	if dev == "" {
		fail(w, http.StatusBadRequest, "no_device")
		return
	}
	var req preKeyUploadReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if len(req.PreKeys) > 200 {
		req.PreKeys = req.PreKeys[:200]
	}
	ids := make([]string, 0, len(req.PreKeys))
	keys := make([][]byte, 0, len(req.PreKeys))
	for _, pk := range req.PreKeys {
		pub, err := b64(pk.Pub, 32, 2048)
		if err != nil {
			continue
		}
		id := sanitizeKeyID(pk.ID)
		if id == "" {
			continue
		}
		ids = append(ids, id)
		keys = append(keys, pub)
	}
	if err := s.st.AddPreKeys(r.Context(), dev, ids, keys); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	left, _ := s.st.CountPreKeys(r.Context(), dev)
	writeJSON(w, http.StatusOK, map[string]any{"stored": len(ids), "available": left})
}

// handleKeyBundles hands out one bundle per device of the target user, each
// consuming a one-time prekey where one is available.
func (s *Server) handleKeyBundles(w http.ResponseWriter, r *http.Request) {
	devices, err := s.st.DevicesForUser(r.Context(), r.PathValue("userId"))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	bundles := make([]store.KeyBundle, 0, len(devices))
	for _, d := range devices {
		id, pub, err := s.st.TakePreKey(r.Context(), d.ID)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal")
			return
		}
		bundles = append(bundles, store.KeyBundle{Device: d, PreKeyID: id, PreKey: pub})
	}
	writeJSON(w, http.StatusOK, map[string]any{"bundles": bundles})
}

type backfillReq struct {
	DeviceID string            `json:"deviceId"`
	Keys     map[string]string `json:"keys"` // messageId -> base64 wrapped key
}

// handleBackfillKeys lets one of a user's devices grant history access to
// another device of the *same* user. Cross-user backfill is refused: that would
// be a server-side key escrow, which is exactly what E2E exists to prevent.
func (s *Server) handleBackfillKeys(w http.ResponseWriter, r *http.Request) {
	var req backfillReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	target, err := s.st.DeviceByID(r.Context(), req.DeviceID)
	if mapStoreErr(w, err) {
		return
	}
	if target.UserID != userID(r) {
		fail(w, http.StatusForbidden, "not_your_device")
		return
	}
	if len(req.Keys) > 5000 {
		fail(w, http.StatusBadRequest, "too_many_keys")
		return
	}
	wrapped := make(map[string][]byte, len(req.Keys))
	for msgID, val := range req.Keys {
		b, err := b64(val, 16, 4096)
		if err != nil {
			continue
		}
		wrapped[msgID] = b
	}
	if err := s.st.BackfillKeys(r.Context(), req.DeviceID, wrapped); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"stored": len(wrapped)})
}

// handleChannelDevices tells a sender exactly which devices it must wrap the
// content key for. Fetching it per send is what makes "new device joins, next
// message is readable" work without any key escrow.
func (s *Server) handleChannelDevices(w http.ResponseWriter, r *http.Request) {
	chID := r.PathValue("id")
	ok, err := s.st.IsMember(r.Context(), chID, userID(r))
	if err != nil || !ok {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	devices, err := s.st.DevicesForChannel(r.Context(), chID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func b64(s string, minLen, maxLen int) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(s)
		if err != nil {
			return nil, err
		}
	}
	if len(b) < minLen || len(b) > maxLen {
		return nil, errBadLen
	}
	return b, nil
}

var errBadLen = &lenError{}

type lenError struct{}

func (*lenError) Error() string { return "unexpected key length" }

// sanitizeKeyID keeps client-chosen pre-key identifiers to a safe alphabet and
// length; they end up in log records and in message headers.
func sanitizeKeyID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 64 {
		return ""
	}
	for _, r := range id {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '-' || r == '_'
		if !ok {
			return ""
		}
	}
	return id
}

func sanitizePlatform(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	switch p {
	case "windows", "linux", "macos", "web", "android", "ios":
		return p
	default:
		return "unknown"
	}
}
