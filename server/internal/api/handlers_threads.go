package api

import (
	"net/http"
	"strings"

	"github.com/kivora-im/kivora/server/internal/auth"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/suite"
)

// Threads.
//
// A thread is a channel with a parent and its own member list, which means the
// existing key machinery covers it with no special cases: content keys are
// wrapped for the thread's devices, so a group member who was not added to a
// thread is not merely hidden from it — no key was ever wrapped for their
// device, and the ciphertext is as opaque to them as to a stranger.

type createThreadReq struct {
	Name    string   `json:"name"`
	Topic   string   `json:"topic"`
	Members []string `json:"members"`
	Suite   string   `json:"suite"`
}

func (s *Server) handleCreateThread(w http.ResponseWriter, r *http.Request) {
	parent, err := s.st.ChannelByID(r.Context(), r.PathValue("id"))
	if mapStoreErr(w, err) {
		return
	}
	if parent.Kind != "group" && parent.Kind != "channel" {
		fail(w, http.StatusBadRequest, "threads_need_a_group")
		return
	}
	member, _ := s.st.IsMember(r.Context(), parent.ID, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}

	var req createThreadReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 80 {
		fail(w, http.StatusBadRequest, "bad_name")
		return
	}
	suiteID := req.Suite
	if suiteID == "" {
		suiteID = parent.Suite
	}
	if err := suite.Validate(suiteID, s.cfg.SuiteAllowed); err != nil {
		fail(w, http.StatusBadRequest, "suite_rejected")
		return
	}

	// Only people who are already in the parent may be given thread keys:
	// a thread is a narrower audience than its group, never a wider one.
	parentMembers, err := s.st.MemberIDs(r.Context(), parent.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	allowed := make(map[string]bool, len(parentMembers))
	for _, id := range parentMembers {
		allowed[id] = true
	}
	selected := map[string]bool{userID(r): true}
	for _, id := range req.Members {
		if allowed[id] {
			selected[id] = true
		}
	}
	ids := make([]string, 0, len(selected))
	for id := range selected {
		ids = append(ids, id)
	}

	thread := &store.Channel{
		ID:        auth.NewID("t"),
		Kind:      "thread",
		ParentID:  parent.ID,
		Name:      name,
		Topic:     strings.TrimSpace(req.Topic),
		OwnerID:   userID(r),
		Encrypted: true, // threads exist to narrow who can read: always E2E
		Suite:     suiteID,
	}
	if err := s.st.CreateChannel(r.Context(), thread, ids); err != nil {
		if mapStoreErr(w, err) {
			return
		}
	}
	thread.Members, _ = s.st.MembersOf(r.Context(), thread.ID)
	s.hub.ToUsers(ids, hub.Event{Type: "thread.created", Channel: parent.ID, Data: mustJSON(thread)})
	writeJSON(w, http.StatusOK, map[string]any{"thread": thread})
}

func (s *Server) handleListThreads(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	member, _ := s.st.IsMember(r.Context(), id, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	threads, err := s.st.ThreadsOf(r.Context(), id, userID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	dev := deviceID(r)
	for i := range threads {
		if last, err := s.st.LastMessage(r.Context(), threads[i].ID, dev); err == nil {
			threads[i].LastMessage = last
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"threads": threads})
}

// ---------------------------------------------------------------- pinning

func (s *Server) handlePinMessage(w http.ResponseWriter, r *http.Request) {
	s.setPinned(w, r, true)
}

func (s *Server) handleUnpinMessage(w http.ResponseWriter, r *http.Request) {
	s.setPinned(w, r, false)
}

func (s *Server) setPinned(w http.ResponseWriter, r *http.Request, pinned bool) {
	m, err := s.st.MessageForDevice(r.Context(), r.PathValue("id"), deviceID(r))
	if mapStoreErr(w, err) {
		return
	}
	member, _ := s.st.IsMember(r.Context(), m.ChannelID, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	if err := s.st.SetPinned(r.Context(), m.ID, pinned); mapStoreErr(w, err) {
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), m.ChannelID)
	s.hub.ToUsers(ids, hub.Event{
		Type: "message.pinned", Channel: m.ChannelID,
		Data: mustJSON(map[string]any{"id": m.ID, "pinned": pinned, "by": userID(r)}),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handlePinnedMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	member, _ := s.st.IsMember(r.Context(), id, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	msgs, err := s.st.PinnedMessages(r.Context(), id, deviceID(r))
	if err != nil {
		fail(w, http.StatusInternalServerError, "internal")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

// ------------------------------------------------------- membership flags

type membershipReq struct {
	Archived *bool `json:"archived"`
	Pinned   *bool `json:"pinned"`
	Muted    *bool `json:"muted"`
}

// handleMembership updates the *personal* view of a chat. Archiving a group
// hides it for one person only — a conversation is shared, but how you file it
// is not.
func (s *Server) handleMembership(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	archived, pinned, muted, err := s.st.MembershipFlags(r.Context(), id, userID(r))
	if err != nil {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	var req membershipReq
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if req.Archived != nil {
		archived = *req.Archived
	}
	if req.Pinned != nil {
		pinned = *req.Pinned
	}
	if req.Muted != nil {
		muted = *req.Muted
	}
	if err := s.st.SetMembershipFlags(r.Context(), id, userID(r), archived, pinned, muted); mapStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{
		"archived": archived, "pinned": pinned, "muted": muted,
	})
}

// handleClearHistory removes the caller's own messages from a chat. It is not
// "delete the conversation": a message belongs to everyone who received it, so
// only the sender's own are burned.
func (s *Server) handleClearHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	member, _ := s.st.IsMember(r.Context(), id, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	// Page backwards through the whole channel rather than taking one slice.
	//
	// This used to read the newest 5000 and stop, which quietly did something
	// other than what the button says: in a busy group the caller's older
	// messages survived, and the reply reported a count with no hint that the
	// sweep had been cut short. "Clear my messages" has to mean all of them.
	const page = 1000
	me := userID(r)
	dev := deviceID(r)
	removed := 0
	var before int64 // 0 means "from the newest"
	for {
		msgs, err := s.st.History(r.Context(), id, dev, before, page)
		if err != nil {
			fail(w, http.StatusInternalServerError, "internal")
			return
		}
		if len(msgs) == 0 {
			break
		}
		for _, m := range msgs {
			if m.SenderID != me || m.Deleted {
				continue
			}
			for _, upload := range s.st.AttachmentsOf(r.Context(), m.ID) {
				_ = s.st.DeleteUpload(r.Context(), upload)
			}
			if err := s.st.DeleteMessage(r.Context(), m.ID, me); err == nil {
				removed++
			}
		}
		// History returns oldest-first, so the next page ends before the
		// oldest sequence number seen here. Reaching seq 1 means the start of
		// the channel.
		oldest := msgs[0].Seq
		if oldest <= 1 {
			break
		}
		before = oldest
	}
	ids, _ := s.st.MemberIDs(r.Context(), id)
	s.hub.ToUsers(ids, hub.Event{Type: "channel.cleared", Channel: id})
	writeJSON(w, http.StatusOK, map[string]int{"removed": removed})
}

// handleSetTTL turns disappearing messages on or off for a chat.
//
// Any member can set it, not only the owner: the timer protects everyone in
// the room, and needing the owner's permission to make your own words expire
// gets the incentives backwards. The change is announced, because a message
// that will delete itself is a fact the other person should know before they
// answer it.
func (s *Server) handleSetTTL(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	member, _ := s.st.IsMember(r.Context(), id, userID(r))
	if !member {
		fail(w, http.StatusForbidden, "not_a_member")
		return
	}
	var req struct {
		TTLSeconds int64 `json:"ttlSeconds"`
	}
	if err := decode(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	// A day either side of the allowed range is a typo, not an intention.
	if req.TTLSeconds < 0 || req.TTLSeconds > 365*24*60*60 {
		fail(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := s.st.SetChannelTTL(r.Context(), id, req.TTLSeconds); mapStoreErr(w, err) {
		return
	}
	ids, _ := s.st.MemberIDs(r.Context(), id)
	s.hub.ToUsers(ids, hub.Event{
		Type: "channel.updated", Channel: id,
		Data: mustJSON(map[string]any{"ttlSeconds": req.TTLSeconds}),
	})
	writeJSON(w, http.StatusOK, map[string]int64{"ttlSeconds": req.TTLSeconds})
}
