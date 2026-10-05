package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/ws"
)

// handleWS upgrades to a websocket. The token arrives as a query parameter
// because browsers cannot set headers on a WebSocket handshake; it is verified
// exactly like a bearer token and never logged.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		token = bearer(r)
	}
	if token == "" {
		fail(w, http.StatusUnauthorized, "missing_token")
		return
	}
	sess, err := s.st.SessionByHash(r.Context(), auth.HashToken(s.cfg.SecretKey, token))
	if err != nil {
		fail(w, http.StatusUnauthorized, "invalid_token")
		return
	}

	conn, err := ws.Accept(w, r, &ws.AcceptOptions{
		OriginPatterns: originPatterns(s.cfg.CORSOrigins),
		ReadLimit:      int64(s.cfg.MaxMessageSize) + 64*1024,
	})
	if err != nil {
		s.log.Debug("ws accept", "err", err)
		return
	}

	c := s.hub.Register(sess.UserID, sess.DeviceID, conn)
	defer func() {
		// A dropped socket must not leave the person listed in a call.
		for _, channelID := range s.hub.LeaveAll(sess.DeviceID) {
			s.broadcastRoom(context.Background(), channelID)
		}
		s.hub.Unregister(c)
	}()

	s.broadcastPresence(r.Context(), sess.UserID, true)
	defer s.broadcastPresence(context.Background(), sess.UserID, false)

	s.hub.ToDevice(sess.UserID, sess.DeviceID, hub.Event{Type: "ready",
		Data: mustJSON(map[string]any{
			"userId":   sess.UserID,
			"deviceId": sess.DeviceID,
			"calls":    s.visibleRooms(r.Context(), sess.UserID),
		})})

	// The read loop exists mainly to notice disconnects and to carry
	// lightweight signals (typing, ping). Anything that mutates state goes
	// through the REST API, where the same validation applies to every client.
	for {
		typ, data, err := conn.Read(time.Now().Add(90 * time.Second))
		if err != nil {
			return
		}
		if typ != ws.OpText {
			continue
		}
		var in hub.Event
		if err := json.Unmarshal(data, &in); err != nil {
			continue
		}
		switch in.Type {
		case "ping":
			s.hub.ToDevice(sess.UserID, sess.DeviceID, hub.Event{Type: "pong"})

		case "typing":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			ids, _ := s.st.MemberIDs(r.Context(), in.Channel)
			s.hub.ToUsers(s.hub.Except(ids, sess.UserID), hub.Event{
				Type: "typing", Channel: in.Channel,
				Data: mustJSON(map[string]string{"userId": sess.UserID}),
			})

		// ---- call signalling ------------------------------------------
		// Everything below is relayed, never interpreted: the payload is an
		// SDP offer or an ICE candidate that only the two peers understand.
		case "call.ring":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			var body struct {
				Video bool `json:"video"`
			}
			_ = json.Unmarshal(in.Data, &body)
			ids, _ := s.st.MemberIDs(r.Context(), in.Channel)
			s.hub.ToUsers(s.hub.Except(ids, sess.UserID), hub.Event{
				Type: "call.ring", Channel: in.Channel,
				Data: mustJSON(map[string]any{
					"from":     sess.UserID,
					"fromName": s.displayName(r, sess.UserID),
					"video":    body.Video,
				}),
			})

		case "call.join":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			var body struct {
				Video bool `json:"video"`
			}
			_ = json.Unmarshal(in.Data, &body)
			s.hub.Join(in.Channel, sess.UserID, sess.DeviceID, body.Video)
			s.broadcastRoom(r.Context(), in.Channel)

		case "call.flags":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			var body struct {
				Video  bool `json:"video"`
				Screen bool `json:"screen"`
			}
			_ = json.Unmarshal(in.Data, &body)
			s.hub.SetCallFlags(in.Channel, sess.DeviceID, body.Video, body.Screen)
			s.broadcastRoom(r.Context(), in.Channel)

		// call.decline is the answer to a ring that is not "I joined".
		//
		// Without it the caller has no way to tell "still deciding" from "no",
		// because declining used to be a purely local dismissal: the callee's
		// banner went away and the caller kept ringing at an empty room. The
		// event carries no payload beyond who declined - the caller only needs
		// to stop.
		case "call.decline":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			ids, _ := s.st.MemberIDs(r.Context(), in.Channel)
			s.hub.ToUsers(s.hub.Except(ids, sess.UserID), hub.Event{
				Type: "call.decline", Channel: in.Channel,
				Data: mustJSON(map[string]any{
					"from":     sess.UserID,
					"fromName": s.displayName(r, sess.UserID),
				}),
			})

		case "call.leave":
			// Membership is checked here like everywhere else. Leaving is
			// harmless in itself, but without the check any authenticated
			// socket could make the server fan out a call.state broadcast into
			// a channel it has nothing to do with.
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			s.hub.Leave(in.Channel, sess.DeviceID)
			s.broadcastRoom(r.Context(), in.Channel)

		case "call.signal":
			if in.Channel == "" || !s.isMember(r, in.Channel, sess.UserID) {
				continue
			}
			var body struct {
				To       string          `json:"to"`
				ToDevice string          `json:"toDevice"`
				Payload  json.RawMessage `json:"payload"`
			}
			if err := json.Unmarshal(in.Data, &body); err != nil || body.ToDevice == "" {
				continue
			}
			// The recipient must be in the same channel: signalling is not a
			// way to reach arbitrary devices on the server.
			if !s.isMember(r, in.Channel, body.To) {
				continue
			}
			s.hub.ToDevice(body.To, body.ToDevice, hub.Event{
				Type: "call.signal", Channel: in.Channel,
				Data: mustJSON(map[string]any{
					"from":       sess.UserID,
					"fromDevice": sess.DeviceID,
					"payload":    body.Payload,
				}),
			})
		}
	}
}

func (s *Server) isMember(r *http.Request, channelID, userID string) bool {
	ok, err := s.st.IsMember(r.Context(), channelID, userID)
	return err == nil && ok
}

func (s *Server) displayName(r *http.Request, id string) string {
	if u, err := s.st.UserByID(r.Context(), id); err == nil {
		return u.DisplayName
	}
	return ""
}

// broadcastRoom tells everyone in the channel who is currently in the call, so
// a late joiner sees the same roster as everyone else.
func (s *Server) broadcastRoom(ctx context.Context, channelID string) {
	room := s.hub.RoomOf(channelID)
	ids, err := s.st.MemberIDs(ctx, channelID)
	if err != nil {
		return
	}
	s.hub.ToUsers(ids, hub.Event{Type: "call.state", Channel: channelID, Data: mustJSON(room)})
}

// visibleRooms lists the live calls in channels this user belongs to.
func (s *Server) visibleRooms(ctx context.Context, userID string) []hub.Room {
	out := []hub.Room{}
	for _, room := range s.hub.ActiveRooms() {
		if ok, err := s.st.IsMember(ctx, room.ChannelID, userID); err == nil && ok {
			out = append(out, room)
		}
	}
	return out
}

// broadcastPresence tells the people who can already see this user that their
// dot turned green — and nobody else. Presence is not public.
func (s *Server) broadcastPresence(ctx context.Context, uid string, online bool) {
	chs, err := s.st.ChannelsForUser(ctx, uid)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	peers := []string{}
	for _, ch := range chs {
		for _, m := range ch.Members {
			if m.UserID == uid || seen[m.UserID] {
				continue
			}
			seen[m.UserID] = true
			peers = append(peers, m.UserID)
		}
	}
	s.hub.ToUsers(peers, hub.Event{Type: "presence",
		Data: mustJSON(map[string]any{"userId": uid, "online": online})})
}

func originPatterns(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, o := range origins {
		o = trimScheme(o)
		if o != "" {
			out = append(out, o)
		}
	}
	return out
}

func trimScheme(o string) string {
	for _, p := range []string{"https://", "http://", "tauri://", "ws://", "wss://"} {
		if len(o) > len(p) && o[:len(p)] == p {
			return o[len(p):]
		}
	}
	return o
}
