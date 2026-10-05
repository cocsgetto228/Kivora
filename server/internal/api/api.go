// Package api is the HTTP surface. It uses nothing but net/http: Go 1.22's
// ServeMux understands method+path patterns, which removes the last reason to
// pull in a router dependency.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/config"
	"github.com/kivora-im/kivora/server/internal/guard"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/suite"
)

type Server struct {
	cfg   *config.Config
	st    *store.Store
	hub   *hub.Hub
	log   *slog.Logger
	web   http.Handler
	limit *guard.Limiter
}

func New(cfg *config.Config, st *store.Store, h *hub.Hub, log *slog.Logger, web http.Handler) *Server {
	return &Server{
		cfg: cfg, st: st, hub: h, log: log, web: web,
		limit: guard.NewLimiter(cfg.RateLimitRPS, cfg.RateLimitBurst),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// --- public ---
	mux.HandleFunc("GET /api/v1/server", s.handleServerInfo)
	mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)

	// --- authenticated ---
	mux.Handle("POST /api/v1/auth/logout", s.authed(s.handleLogout))
	mux.Handle("GET /api/v1/me", s.authed(s.handleMe))
	mux.Handle("PATCH /api/v1/me", s.authed(s.handleUpdateMe))
	mux.Handle("GET /api/v1/users", s.authed(s.handleSearchUsers))

	// --- files ---
	mux.Handle("POST /api/v1/uploads", s.authed(s.handleUpload))
	mux.Handle("GET /api/v1/uploads/{id}", s.authed(s.handleDownload))
	mux.Handle("POST /api/v1/uploads/avatar", s.authed(s.handleAvatarUpload))
	mux.Handle("GET /api/v1/avatars/{id}", s.authed(s.handleAvatar))

	mux.Handle("POST /api/v1/devices", s.authed(s.handleRegisterDevice))
	mux.Handle("GET /api/v1/devices", s.authed(s.handleListDevices))
	mux.Handle("POST /api/v1/devices/{id}/attach", s.authed(s.handleAttachDevice))
	mux.Handle("DELETE /api/v1/devices/{id}", s.authed(s.handleRevokeDevice))
	mux.Handle("POST /api/v1/devices/prekeys", s.authed(s.handleUploadPreKeys))
	mux.Handle("GET /api/v1/keys/{userId}", s.authed(s.handleKeyBundles))
	mux.Handle("POST /api/v1/keys/backfill", s.authed(s.handleBackfillKeys))

	mux.Handle("GET /api/v1/channels", s.authed(s.handleListChannels))
	mux.Handle("POST /api/v1/channels", s.authed(s.handleCreateChannel))
	mux.Handle("GET /api/v1/channels/browse", s.authed(s.handleBrowseChannels))
	mux.Handle("POST /api/v1/channels/direct", s.authed(s.handleOpenDirect))
	mux.Handle("GET /api/v1/channels/{id}", s.authed(s.handleGetChannel))
	mux.Handle("PATCH /api/v1/channels/{id}", s.authed(s.handleUpdateChannel))
	mux.Handle("POST /api/v1/channels/{id}/join", s.authed(s.handleJoinChannel))
	mux.Handle("POST /api/v1/channels/{id}/leave", s.authed(s.handleLeaveChannel))
	mux.Handle("POST /api/v1/channels/{id}/members", s.authed(s.handleAddMember))
	mux.Handle("GET /api/v1/channels/{id}/devices", s.authed(s.handleChannelDevices))
	mux.Handle("GET /api/v1/channels/{id}/messages", s.authed(s.handleHistory))
	mux.Handle("POST /api/v1/channels/{id}/messages", s.authed(s.handleSend))
	mux.Handle("POST /api/v1/channels/{id}/read", s.authed(s.handleMarkRead))
	mux.Handle("DELETE /api/v1/messages/{id}", s.authed(s.handleDeleteMessage))
	mux.Handle("POST /api/v1/channels/{id}/typing", s.authed(s.handleTyping))

	// --- pins, threads, personal chat state ---
	mux.Handle("POST /api/v1/messages/{id}/pin", s.authed(s.handlePinMessage))
	mux.Handle("DELETE /api/v1/messages/{id}/pin", s.authed(s.handleUnpinMessage))
	mux.Handle("GET /api/v1/channels/{id}/pinned", s.authed(s.handlePinnedMessages))
	mux.Handle("PATCH /api/v1/channels/{id}/membership", s.authed(s.handleMembership))
	mux.Handle("POST /api/v1/channels/{id}/clear", s.authed(s.handleClearHistory))
	mux.Handle("PATCH /api/v1/channels/{id}/ttl", s.authed(s.handleSetTTL))
	mux.Handle("GET /api/v1/channels/{id}/threads", s.authed(s.handleListThreads))
	mux.Handle("POST /api/v1/channels/{id}/threads", s.authed(s.handleCreateThread))

	// --- calls ---
	mux.Handle("GET /api/v1/ice", s.authed(s.handleICE))

	// --- administration ---
	mux.Handle("GET /api/v1/admin/overview", s.authed(s.adminOnly(s.handleAdminOverview)))
	mux.Handle("GET /api/v1/admin/users", s.authed(s.adminOnly(s.handleAdminUsers)))
	mux.Handle("POST /api/v1/admin/users/{id}/flags", s.authed(s.adminOnly(s.handleAdminUserFlags)))
	mux.Handle("GET /api/v1/admin/channels", s.authed(s.adminOnly(s.handleAdminChannels)))
	mux.Handle("POST /api/v1/admin/compact", s.authed(s.adminOnly(s.handleAdminCompact)))

	mux.HandleFunc("GET /api/v1/ws", s.handleWS) // auth is done inside (token in query)

	// --- static web client ---
	if s.web != nil {
		mux.Handle("/", s.web)
	}

	return guard.Chain(mux,
		guard.Recover(s.log),
		guard.SecurityHeaders,
		guard.CORS(s.cfg.CORSOrigins),
		guard.MaxBody(s.cfg.MaxUploadBytes),
		s.limit.Middleware(s.cfg.TrustProxy),
	)
}

// ---------------------------------------------------------------- context

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxDevice
	ctxToken
)

func userID(r *http.Request) string   { v, _ := r.Context().Value(ctxUser).(string); return v }
func deviceID(r *http.Request) string { v, _ := r.Context().Value(ctxDevice).(string); return v }
func tokenOf(r *http.Request) string  { v, _ := r.Context().Value(ctxToken).(string); return v }

// authed wraps a handler with bearer-token authentication. The device id is
// taken from the session, never from a client header, so a stolen token cannot
// be used to impersonate another device and harvest its wrapped keys.
func (s *Server) authed(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		if token == "" {
			fail(w, http.StatusUnauthorized, "missing_token")
			return
		}
		sess, err := s.st.SessionByHash(r.Context(), auth.HashToken(s.cfg.SecretKey, token))
		if err != nil {
			fail(w, http.StatusUnauthorized, "invalid_token")
			return
		}
		// A suspension has to bite immediately, not at the next login.
		if u, err := s.st.UserByID(r.Context(), sess.UserID); err == nil && u.Suspended {
			fail(w, http.StatusForbidden, "suspended")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUser, sess.UserID)
		ctx = context.WithValue(ctx, ctxDevice, sess.DeviceID)
		ctx = context.WithValue(ctx, ctxToken, token)
		s.st.TouchUser(ctx, sess.UserID)
		if sess.DeviceID != "" {
			s.st.TouchDevice(ctx, sess.DeviceID)
		}
		h(w, r.WithContext(ctx))
	})
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func fail(w http.ResponseWriter, code int, reason string) {
	writeJSON(w, code, map[string]string{"error": reason})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 8<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	return nil
}

func intQuery(r *http.Request, key string, def, max int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func int64Query(r *http.Request, key string) int64 {
	n, _ := strconv.ParseInt(r.URL.Query().Get(key), 10, 64)
	return n
}

func mapStoreErr(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, store.ErrNotFound):
		fail(w, http.StatusNotFound, "not_found")
	case errors.Is(err, store.ErrConflict):
		fail(w, http.StatusConflict, "conflict")
	default:
		fail(w, http.StatusInternalServerError, "internal")
	}
	return true
}

// ---------------------------------------------------------------- server info

type serverInfo struct {
	Name             string             `json:"name"`
	Version          string             `json:"version"`
	Protocol         int                `json:"protocol"`
	RegistrationMode string             `json:"registrationMode"`
	RequireE2E       bool               `json:"requireE2E"`
	AllowedSuites    []string           `json:"allowedSuites"`
	Suites           []suite.Descriptor `json:"suites"`
	MaxMessageBytes  int                `json:"maxMessageBytes"`
	MaxUploadBytes   int64              `json:"maxUploadBytes"`
	MaxFileBytes     int64              `json:"maxFileBytes"`
	MaxAvatarBytes   int64              `json:"maxAvatarBytes"`
	Calls            bool               `json:"calls"`
}

// Version is stamped at build time: -ldflags "-X .../api.Version=1.2.3"
var Version = "0.1.0-dev"

const ProtocolVersion = 1

func (s *Server) handleServerInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, serverInfo{
		Name:             "Kivora",
		Version:          Version,
		Protocol:         ProtocolVersion,
		RegistrationMode: s.cfg.RegistrationMode,
		RequireE2E:       s.cfg.RequireE2E,
		AllowedSuites:    s.cfg.AllowedSuites,
		Suites:           suite.Builtin(),
		MaxMessageBytes:  s.cfg.MaxMessageSize,
		MaxUploadBytes:   s.cfg.MaxUploadBytes,
		MaxFileBytes:     s.cfg.MaxFileBytes,
		MaxAvatarBytes:   s.cfg.MaxAvatarBytes,
		Calls:            len(s.cfg.StunURLs) > 0 || s.cfg.TurnURL != "",
	})
}
