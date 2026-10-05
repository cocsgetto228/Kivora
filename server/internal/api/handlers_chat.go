package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/suite"
)

// ---------------------------------------------------------------- channels

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	chs, err := s.st.ChannelsForUser(r.Context(), userID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	dev := deviceID(r)
	for i := range chs {
		if last, err := s.st.LastMessage(r.Context(), chs[i].ID, dev); err == nil {
			chs[i].LastMessage = last
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": chs, "online": s.hub.OnlineUsers()})
}

func (s *Server) handleBrowseChannels(w http.ResponseWriter, r *http.Request) {
	chs, err := s.st.PublicChannels(r.Context(), userID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": chs})
}

type createChannelReq struct {
	Kind      string   `json:"kind"` // "group" | "channel"
	Name      string   `json:"name"`
	Topic     string   `json:"topic"`
	Members   []string `json:"members"`
	Encrypted bool     `json:"encrypted"`
	Suite     string   `json:"suite"`
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var req createChannelReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if req.Kind != "group" && req.Kind != "channel" {
		fail(w, http.StatusBadRequest, "bad_kind")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 80 {
		fail(w, http.StatusBadRequest, "bad_name")
		return
	}
	// Private groups are always E2E. Open channels may be plaintext-on-server
	// so that search and moderation are possible — the operator chooses.
	encrypted := req.Encrypted || req.Kind == "group"
	if s.cfg.RequireE2E {
		encrypted = true
	}
	if encrypted {
		if err := suite.Validate(req.Suite, s.cfg.SuiteAllowed); err != nil {
			fail(w, http.StatusBadRequest, "suite_rejected")
			return
		}
	}

	members := map[string]bool{userID(r): true}
	for _, m := range req.Members {
		members[m] = true
	}
	ids := make([]string, 0, len(members))
	for id := range members {
		if _, err := s.st.UserByID(r.Context(), id); err == nil {
			ids = append(ids, id)
		}
	}

	c := &store.Channel{
		ID: auth.NewID("c"), Kind: req.Kind, Name: name,
		Topic: strings.TrimSpace(req.Topic), OwnerID: userID(r),
		Encrypted: encrypted, Suite: req.Suite,
	}
	if req.Kind == "channel" {
		c.Slug = store.Slugify(name)
		if c.Slug == "" {
			c.Slug = strings.ToLower(auth.NewID(""))[:8]
		}
	}
	if err := s.st.CreateChannel(r.Context(), c, ids); err != nil {
		if mapStoreErr(w, err) {
			return
		}
	}
	c.Members, _ = s.st.MembersOf(r.Context(), c.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.created", Channel: c.ID, Data: mustJSON(c)})
	writeJSON(w, http.StatusOK, map[string]any{"channel": c})
}

type directReq struct {
	UserID string `json:"userId"`
	Suite  string `json:"suite"`
}

// handleOpenDirect is idempotent: opening a DM twice returns the same channel.
func (s *Server) handleOpenDirect(w http.ResponseWriter, r *http.Request) {
	var req directReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	me := userID(r)
	other, err := s.st.UserByID(r.Context(), req.UserID)
	if mapStoreErr(w, err) {
		return
	}
	if existing, err := s.st.DirectChannelBetween(r.Context(), me, other.ID); err == nil {
		existing.Members, _ = s.st.MembersOf(r.Context(), existing.ID)
		writeJSON(w, http.StatusOK, map[string]any{"channel": existing})
		return
	}
	if err := suite.Validate(req.Suite, s.cfg.SuiteAllowed); err != nil {
		fail(w, http.StatusBadRequest, "suite_rejected")
		return
	}
	c := &store.Channel{
		ID: auth.NewID("c"), Kind: "dm", OwnerID: me,
		Encrypted: true, Suite: req.Suite,
	}
	ids := []string{me}
	if other.ID != me {
		ids = append(ids, other.ID)
	}
	if err := s.st.CreateChannel(r.Context(), c, ids); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	c.Members, _ = s.st.MembersOf(r.Context(), c.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.created", Channel: c.ID, Data: mustJSON(c)})
	writeJSON(w, http.StatusOK, map[string]any{"channel": c})
}

func (s *Server) handleGetChannel(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.ChannelByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	member, _ := s.st.IsMember(r.Context(), c.ID, userID(r))
	if !member && c.Kind != "channel" {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	c.Members, _ = s.st.MembersOf(r.Context(), c.ID)
	writeJSON(w, http.StatusOK, map[string]any{"channel": c, "isMember": member})
}

type updateChannelReq struct {
	Name   string  `json:"name"`
	Topic  string  `json:"topic"`
	Avatar *string `json:"avatar"`
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.ChannelByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if c.OwnerID != userID(r) {
		fail(w, http.StatusForbidden, "not_owner")
		return
	}
	var req updateChannelReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := s.st.UpdateChannelMeta(r.Context(), c.ID, strings.TrimSpace(req.Name), strings.TrimSpace(req.Topic)); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	if req.Avatar != nil {
		avatar := strings.TrimSpace(*req.Avatar)
		if avatar != "" {
			up, err := s.st.UploadMeta(r.Context(), avatar)
			if err != nil || up.Kind != "avatar" || up.OwnerID != userID(r) {
				fail(w, http.StatusBadRequest, "bad_avatar")
				return
			}
		}
		if c.Avatar != "" && c.Avatar != avatar {
			_ = s.st.DeleteUpload(r.Context(), c.Avatar)
		}
		if err := s.st.SetChannelAvatar(r.Context(), c.ID, avatar); mapStoreErr(w, err) {
			return
		}
	}
	updated, _ := s.st.ChannelByID(r.Context(), c.ID)
	ids, _ := s.st.MemberIDs(r.Context(), c.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.updated", Channel: c.ID, Data: mustJSON(updated)})
	writeJSON(w, http.StatusOK, map[string]any{"channel": updated})
}

func (s *Server) handleJoinChannel(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.ChannelByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if c.Kind != "channel" {
		fail(w, http.StatusForbidden, "invite_only")
		return
	}
	if err := s.st.AddMember(r.Context(), c.ID, userID(r), "member"); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), c.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.members", Channel: c.ID})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLeaveChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ids, _ := s.st.MemberIDs(r.Context(), id)
	if err := s.st.RemoveMember(r.Context(), id, userID(r)); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	s.hub.ToUsers(ids, hub.Event{Type: "channel.members", Channel: id})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type addMemberReq struct {
	UserID string `json:"userId"`
}

func (s *Server) handleAddMember(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.ChannelByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	member, _ := s.st.IsMember(r.Context(), c.ID, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	if c.Kind == "dm" {
		fail(w, http.StatusBadRequest, "cannot_add_to_dm")
		return
	}
	var req addMemberReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if _, err := s.st.UserByID(r.Context(), req.UserID); mapStoreErr(w, err) {
		return
	}
	if err := s.st.AddMember(r.Context(), c.ID, req.UserID, "member"); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), c.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.members", Channel: c.ID})
	c.Members, _ = s.st.MembersOf(r.Context(), c.ID)
	s.hub.ToUsers([]string{req.UserID}, hub.Event{Type: "channel.created", Channel: c.ID, Data: mustJSON(c)})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- messages

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	chID := r.PathValue("id")
	ok, err := s.st.IsMember(r.Context(), chID, userID(r))
	if err != nil || !ok {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	msgs, err := s.st.History(r.Context(), chID, deviceID(r),
		int64Query(r, "before"), intQuery(r, "limit", 50, 200))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

type sendReq struct {
	Kind    string            `json:"kind"`
	Suite   string            `json:"suite"`
	Header  string            `json:"header"` // base64, opaque
	Body    string            `json:"body"`   // base64, opaque ciphertext
	Keys    map[string]string `json:"keys"`   // deviceId -> base64 wrapped content key
	ReplyTo string            `json:"replyTo"`
	Nonce   string            `json:"clientId"` // client-side dedupe id, echoed back
	// Attachments are upload ids created earlier in this channel by this user.
	Attachments []string `json:"attachments"`
}

// handleSend takes a fully-encrypted payload. Note what is missing: there is no
// branch anywhere below that inspects, transforms, or logs `Body`.
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	chID := r.PathValue("id")
	dev := deviceID(r)
	if dev == "" {
		fail(w, http.StatusBadRequest, "no_device")
		return
	}
	c, err := s.st.ChannelByID(r.Context(), chID)
	if mapStoreErr(w, err) {
		return
	}
	member, _ := s.st.IsMember(r.Context(), chID, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	var req sendReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	body, err := base64.StdEncoding.DecodeString(req.Body)
	if err != nil || len(body) == 0 {
		fail(w, http.StatusBadRequest, "bad_body")
		return
	}
	if len(body) > s.cfg.MaxMessageSize {
		fail(w, http.StatusRequestEntityTooLarge, "message_too_large")
		return
	}
	if c.Encrypted {
		if err := suite.Validate(req.Suite, s.cfg.SuiteAllowed); err != nil {
			fail(w, http.StatusBadRequest, "suite_rejected")
			return
		}
		if c.Suite != "" && !suite.Compatible(req.Suite, c.Suite) {
			fail(w, http.StatusBadRequest, "suite_mismatch")
			return
		}
		if len(req.Keys) == 0 {
			fail(w, http.StatusBadRequest, "missing_keys")
			return
		}
	}
	var header []byte
	if req.Header != "" {
		header, _ = base64.StdEncoding.DecodeString(req.Header)
	}

	// Only wrap for devices that are actually members of this channel: a
	// client cannot smuggle a key to an outsider's device id.
	allowed, err := s.st.DevicesForChannel(r.Context(), chID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	valid := make(map[string]bool, len(allowed))
	for _, d := range allowed {
		valid[d.ID] = true
	}
	wrapped := make(map[string][]byte, len(req.Keys))
	for devID, val := range req.Keys {
		if !valid[devID] {
			continue
		}
		k, err := base64.StdEncoding.DecodeString(val)
		if err != nil || len(k) == 0 || len(k) > 4096 {
			continue
		}
		wrapped[devID] = k
	}

	kind := req.Kind
	if kind == "" {
		kind = "text"
	}

	// Attachments must be uploads this user made into this very channel.
	// Otherwise a message could "adopt" someone else's file and hand its bytes
	// to a different audience.
	attachments := make([]string, 0, len(req.Attachments))
	if len(req.Attachments) > 12 {
		fail(w, http.StatusBadRequest, "too_many_attachments")
		return
	}
	for _, id := range req.Attachments {
		up, err := s.st.UploadMeta(r.Context(), id)
		if err != nil || up.Kind != "media" || up.ChannelID != chID || up.OwnerID != userID(r) {
			fail(w, http.StatusBadRequest, "bad_attachment")
			return
		}
		attachments = append(attachments, id)
	}

	m := &store.Message{
		ID: auth.NewID("m"), ChannelID: chID, SenderID: userID(r), SenderDevice: dev,
		Suite: req.Suite, Kind: kind, Header: header, Body: body, ReplyTo: req.ReplyTo,
		Attachments: attachments,
	}
	if err := s.st.InsertMessage(r.Context(), m, wrapped); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}

	s.fanout(r, chID, m, wrapped)
	out := *m
	out.WrappedKey = wrapped[dev]
	writeJSON(w, http.StatusOK, map[string]any{"message": out, "clientId": req.Nonce})
}

// fanout pushes the message to every member, giving each connected device its
// own wrapped key and nobody else's.
func (s *Server) fanout(r *http.Request, chID string, m *store.Message, wrapped map[string][]byte) {
	memberIDs, err := s.st.MemberIDs(r.Context(), chID)
	if err != nil {
		return
	}
	devices, err := s.st.DevicesForChannel(r.Context(), chID)
	if err != nil {
		return
	}
	byUser := map[string]map[string]hub.Event{}
	for _, d := range devices {
		copyMsg := *m
		copyMsg.WrappedKey = wrapped[d.ID]
		if byUser[d.UserID] == nil {
			byUser[d.UserID] = map[string]hub.Event{}
		}
		byUser[d.UserID][d.ID] = hub.Event{Type: "message.new", Channel: chID, Data: mustJSON(copyMsg)}
	}
	for uid, per := range byUser {
		s.hub.ToUserDevices(uid, per)
	}
	// Members with no registered device still get a nudge so their unread
	// badge and channel ordering update.
	plain := hub.Event{Type: "channel.bump", Channel: chID}
	s.hub.ToUsers(memberIDs, plain)
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m, err := s.st.MessageForDevice(r.Context(), id, deviceID(r))
	if mapStoreErr(w, err) {
		return
	}
	// The files go with the message: leaving orphaned ciphertext behind would
	// make "delete for everyone" a half-truth.
	for _, upload := range s.st.AttachmentsOf(r.Context(), id) {
		_ = s.st.DeleteUpload(r.Context(), upload)
	}
	if err := s.st.DeleteMessage(r.Context(), id, userID(r)); err != nil {
		fail(w, http.StatusForbidden, "forbidden")
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), m.ChannelID)
	s.hub.ToUsers(ids, hub.Event{Type: "message.deleted", Channel: m.ChannelID,
		Data: mustJSON(map[string]string{"id": id})})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type readReq struct {
	Seq int64 `json:"seq"`
}

func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	var req readReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := s.st.SetLastRead(r.Context(), r.PathValue("id"), userID(r), req.Seq); err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleTyping(w http.ResponseWriter, r *http.Request) {
	chID := r.PathValue("id")
	ok, _ := s.st.IsMember(r.Context(), chID, userID(r))
	if !ok {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), chID)
	s.hub.ToUsers(s.hub.Except(ids, userID(r)), hub.Event{
		Type: "typing", Channel: chID, Data: mustJSON(map[string]string{"userId": userID(r)}),
	})
	w.WriteHeader(http.StatusNoContent)
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return b
}
