package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/store"
)

type registerReq struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
	InviteCode  string `json:"inviteCode"`
	DeviceName  string `json:"deviceName"`
	Platform    string `json:"platform"`
}

type authResp struct {
	Token  string      `json:"token"`
	User   *store.User `json:"user"`
	Device string      `json:"deviceId,omitempty"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if s.cfg.RegistrationMode == "closed" {
		fail(w, http.StatusForbidden, "registration_closed")
		return
	}
	var req registerReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if s.cfg.RegistrationMode == "invite" && !s.inviteValid(req.InviteCode) {
		fail(w, http.StatusForbidden, "bad_invite")
		return
	}
	username := strings.ToLower(strings.TrimSpace(req.Username))
	if err := validateUsername(username); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len([]rune(req.Password)) < 8 {
		fail(w, http.StatusBadRequest, "password_too_short")
		return
	}
	display := strings.TrimSpace(req.DisplayName)
	if display == "" {
		display = req.Username
	}

	hash, err := auth.HashPassword(req.Password, auth.Params{
		Memory: s.cfg.Argon2Memory, Time: s.cfg.Argon2Time,
		Threads: s.cfg.Argon2Threads, KeyLen: 32, SaltLen: 16,
	})
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}

	count, _ := s.st.CountUsers(r.Context())
	u := &store.User{
		ID:           auth.NewID("u"),
		Username:     username,
		DisplayName:  display,
		PasswordHash: hash,
		AvatarHue:    hueFor(username),
		IsAdmin:      count == 0, // the first account to register owns the server
	}
	if err := s.st.CreateUser(r.Context(), u); err != nil {
		if errors.Is(err, store.ErrConflict) {
			fail(w, http.StatusConflict, "username_taken")
			return
		}
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	s.log.Info("user registered", "username", u.Username, "admin", u.IsAdmin)
	s.issueSession(w, r, u)
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	u, err := s.st.UserByUsername(r.Context(), strings.TrimSpace(req.Username))
	if err != nil {
		// Spend the same work on a missing user as on a wrong password so the
		// response time does not reveal which accounts exist.
		_, _ = auth.HashPassword(req.Password, auth.Params{
			Memory: s.cfg.Argon2Memory, Time: s.cfg.Argon2Time, Threads: s.cfg.Argon2Threads,
			KeyLen: 32, SaltLen: 16,
		})
		fail(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	ok, err := auth.VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !ok {
		fail(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	if u.Suspended {
		fail(w, http.StatusForbidden, "suspended")
		return
	}
	s.issueSession(w, r, u)
}

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, u *store.User) {
	token, hash, err := auth.NewToken(s.cfg.SecretKey)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	ua := r.UserAgent()
	if len(ua) > 200 {
		ua = ua[:200]
	}
	if err := s.st.CreateSession(r.Context(), hash, u.ID, "", ua, s.cfg.SessionTTL); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, authResp{Token: token, User: u})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.st.DeleteSession(r.Context(), auth.HashToken(s.cfg.SecretKey, tokenOf(r)))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := s.st.UserByID(r.Context(), userID(r))
	if mapStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "deviceId": deviceID(r)})
}

type updateMeReq struct {
	DisplayName string `json:"displayName"`
	Bio         string `json:"bio"`
	// Avatar is an upload id from POST /uploads/avatar, or "" to go back to
	// the generated initials.
	Avatar *string `json:"avatar"`
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	var req updateMeReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" || len([]rune(name)) > 64 {
		fail(w, http.StatusBadRequest, "bad_display_name")
		return
	}
	if len([]rune(req.Bio)) > 280 {
		fail(w, http.StatusBadRequest, "bio_too_long")
		return
	}

	me, err := s.st.UserByID(r.Context(), userID(r))
	if mapStoreErr(w, err) {
		return
	}
	avatar := me.Avatar
	if req.Avatar != nil {
		avatar = strings.TrimSpace(*req.Avatar)
		if avatar != "" {
			// Only an avatar this account actually uploaded may be attached to
			// it; otherwise anyone could wear someone else's face.
			up, err := s.st.UploadMeta(r.Context(), avatar)
			if err != nil || up.Kind != "avatar" || up.OwnerID != me.ID {
				fail(w, http.StatusBadRequest, "bad_avatar")
				return
			}
		}
		if me.Avatar != "" && me.Avatar != avatar {
			_ = s.st.DeleteUpload(r.Context(), me.Avatar)
		}
	}

	if err := s.st.UpdateProfile(r.Context(), userID(r), name, req.Bio, avatar); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	u, _ := s.st.UserByID(r.Context(), userID(r))
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

func (s *Server) handleSearchUsers(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"users": []any{}})
		return
	}
	users, err := s.st.SearchUsers(r.Context(), q, intQuery(r, "limit", 20, 50))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) inviteValid(code string) bool {
	for _, c := range s.cfg.InviteCodes {
		if auth.ConstantTimeEqualString(c, code) {
			return true
		}
	}
	return false
}

func validateUsername(u string) error {
	if len(u) < 3 || len(u) > 32 {
		return errors.New("username_length")
	}
	for _, r := range u {
		if !unicode.IsLower(r) && !unicode.IsDigit(r) && r != '_' && r != '.' && r != '-' {
			return errors.New("username_charset")
		}
	}
	if u[0] == '.' || u[0] == '-' || u[0] == '_' {
		return errors.New("username_charset")
	}
	return nil
}

// hueFor gives every account a stable avatar colour without storing an image.
func hueFor(s string) int {
	h := 0
	for _, r := range s {
		h = (h*31 + int(r)) % 360
	}
	return h
}
