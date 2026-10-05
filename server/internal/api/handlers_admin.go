package api

import (
	"net/http"
	"runtime"
	"time"

	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
)

// The administration API.
//
// Note what is absent: there is no endpoint that returns message content, and
// none that could. An administrator of a Kivora server can see who talks to
// whom and how often, can suspend an account and can compact the store — but
// the ciphertext is as unreadable to them as to anyone else. That is the point
// of the design, and it survives the admin panel.

var startedAt = time.Now()

// adminOnly wraps a handler with a rights check. It reads the flag from the
// store on every call rather than trusting anything the client sends, so
// demoting an administrator takes effect on their next request.
func (s *Server) adminOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := s.st.UserByID(r.Context(), userID(r))
		if err != nil || !u.IsAdmin || u.Suspended {
			fail(w, http.StatusForbidden, "forbidden")
			return
		}
		h(w, r)
	}
}

type adminOverview struct {
	Users     int   `json:"users"`
	Online    int   `json:"online"`
	Channels  int   `json:"channels"`
	Messages  int   `json:"messages"`
	Devices   int   `json:"devices"`
	FileBytes int64 `json:"fileBytes"`
	LogBytes  int64 `json:"logBytes"`
	UptimeSec int64 `json:"uptimeSec"`

	MessagesPerDay []int    `json:"messagesPerDay"`
	SignupsPerDay  []int    `json:"signupsPerDay"`
	Days           []string `json:"days"`

	Recent []store.User `json:"recent"`

	Policy struct {
		Registration  string   `json:"registration"`
		AllowedSuites []string `json:"allowedSuites"`
		RequireE2E    bool     `json:"requireE2E"`
		RateRPS       float64  `json:"rateRps"`
		RateBurst     int      `json:"rateBurst"`
		MaxDevices    int      `json:"maxDevices"`
		MaxFileMB     int64    `json:"maxFileMb"`
		SessionDays   int      `json:"sessionDays"`
		Sync          string   `json:"sync"`
	} `json:"policy"`

	Runtime struct {
		Go       string `json:"go"`
		OS       string `json:"os"`
		Arch     string `json:"arch"`
		Routines int    `json:"goroutines"`
		HeapMB   uint64 `json:"heapMb"`
	} `json:"runtime"`
}

func (s *Server) handleAdminOverview(w http.ResponseWriter, r *http.Request) {
	const days = 7
	nowMs := time.Now().UnixMilli()

	stats := s.st.Stats()
	var out adminOverview
	out.Users, _ = stats["users"].(int)
	out.Channels, _ = stats["channels"].(int)
	out.Messages, _ = stats["messages"].(int)
	out.LogBytes, _ = stats["logBytes"].(int64)
	out.Devices = s.st.CountAllDevices()
	out.FileBytes = s.st.UploadsBytesTotal()
	out.Online = len(s.hub.OnlineUsers())
	out.UptimeSec = int64(time.Since(startedAt).Seconds())

	out.MessagesPerDay = s.st.MessagesPerDay(days, nowMs)
	out.SignupsPerDay = s.st.RegistrationsPerDay(days, nowMs)
	out.Days = make([]string, days)
	for i := 0; i < days; i++ {
		out.Days[i] = time.UnixMilli(nowMs).AddDate(0, 0, -(days - 1 - i)).Format("2006-01-02")
	}

	recent := s.st.AllUsers(r.Context())
	if len(recent) > 8 {
		recent = recent[:8]
	}
	out.Recent = recent

	out.Policy.Registration = s.cfg.RegistrationMode
	out.Policy.AllowedSuites = s.cfg.AllowedSuites
	out.Policy.RequireE2E = s.cfg.RequireE2E
	out.Policy.RateRPS = s.cfg.RateLimitRPS
	out.Policy.RateBurst = s.cfg.RateLimitBurst
	out.Policy.MaxDevices = s.cfg.MaxDevices
	out.Policy.MaxFileMB = s.cfg.MaxFileBytes >> 20
	out.Policy.SessionDays = int(s.cfg.SessionTTL.Hours() / 24)
	out.Policy.Sync = s.cfg.Sync

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	out.Runtime.Go = runtime.Version()
	out.Runtime.OS = runtime.GOOS
	out.Runtime.Arch = runtime.GOARCH
	out.Runtime.Routines = runtime.NumGoroutine()
	out.Runtime.HeapMB = mem.HeapAlloc >> 20

	writeJSON(w, http.StatusOK, out)
}

type adminUserRow struct {
	store.User
	Devices int  `json:"devices"`
	Online  bool `json:"online"`
}

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	users := s.st.AllUsers(r.Context())
	online := map[string]bool{}
	for _, id := range s.hub.OnlineUsers() {
		online[id] = true
	}
	rows := make([]adminUserRow, 0, len(users))
	for _, u := range users {
		n, _ := s.st.CountDevices(r.Context(), u.ID)
		rows = append(rows, adminUserRow{User: u, Devices: n, Online: online[u.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": rows})
}

type adminFlagsReq struct {
	IsAdmin   *bool `json:"isAdmin"`
	Suspended *bool `json:"suspended"`
}

func (s *Server) handleAdminUserFlags(w http.ResponseWriter, r *http.Request) {
	target, err := s.st.UserByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	var req adminFlagsReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	isAdmin, suspended := target.IsAdmin, target.Suspended
	if req.IsAdmin != nil {
		isAdmin = *req.IsAdmin
	}
	if req.Suspended != nil {
		suspended = *req.Suspended
	}

	// Never let the server end up with nobody who can administer it.
	losingAdmin := target.IsAdmin && !target.Suspended && (!isAdmin || suspended)
	if losingAdmin && s.st.CountAdmins(r.Context()) <= 1 {
		fail(w, http.StatusConflict, "last_admin")
		return
	}

	if err := s.st.SetUserFlags(r.Context(), target.ID, isAdmin, suspended); mapStoreErr(w, err) {
		return
	}
	s.log.Info("admin changed user flags",
		"actor", userID(r), "target", target.Username, "admin", isAdmin, "suspended", suspended)

	if suspended {
		s.hub.ToUsers([]string{target.ID}, hub.Event{Type: "session.revoked"})
	}
	updated, _ := s.st.UserByID(r.Context(), target.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

type adminChannelRow struct {
	store.Channel
	MessageCount int `json:"messageCount"`
	MemberCount  int `json:"memberCount"`
}

func (s *Server) handleAdminChannels(w http.ResponseWriter, r *http.Request) {
	channels := s.st.AllChannels(r.Context())
	rows := make([]adminChannelRow, 0, len(channels))
	for _, c := range channels {
		row := adminChannelRow{Channel: c, MessageCount: s.st.CountMessagesIn(c.ID), MemberCount: len(c.Members)}
		// The admin list is metadata only: drop the projected last message so
		// even ciphertext does not travel where it is not needed.
		row.LastMessage = nil
		row.Members = nil
		rows = append(rows, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": rows})
}

func (s *Server) handleAdminCompact(w http.ResponseWriter, r *http.Request) {
	if err := s.st.Compact(); err != nil {
		s.log.Error("compact", "err", err)
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	s.log.Info("store compacted by administrator", "actor", userID(r))
	writeJSON(w, http.StatusOK, s.st.Stats())
}

// ---------------------------------------------------------------- calls

// handleICE hands the client the STUN/TURN configuration the operator set. It
// is authenticated: TURN credentials are worth something, and an open endpoint
// would turn the deployment into a free relay for strangers.
func (s *Server) handleICE(w http.ResponseWriter, r *http.Request) {
	type iceServer struct {
		URLs       []string `json:"urls"`
		Username   string   `json:"username,omitempty"`
		Credential string   `json:"credential,omitempty"`
	}
	servers := []iceServer{}
	if len(s.cfg.StunURLs) > 0 {
		servers = append(servers, iceServer{URLs: s.cfg.StunURLs})
	}
	if s.cfg.TurnURL != "" {
		servers = append(servers, iceServer{
			URLs:       []string{s.cfg.TurnURL},
			Username:   s.cfg.TurnUser,
			Credential: s.cfg.TurnPass,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"iceServers": servers,
		"hasRelay":   s.cfg.TurnURL != "",
	})
}
