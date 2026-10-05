package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/ws"
)

// raw posts bytes rather than JSON — the shape uploads use.
func (e *testEnv) raw(t *testing.T, method, path, token, contentType string, body []byte) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

func (e *testEnv) bytes(t *testing.T, path, token string) (int, []byte, http.Header) {
	t.Helper()
	req, _ := http.NewRequest("GET", e.srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw, resp.Header
}

func (e *testEnv) dm(t *testing.T, a account, otherID string) string {
	t.Helper()
	code, body := e.do(t, "POST", "/api/v1/channels/direct", a.token, map[string]any{
		"userId": otherID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	if code != 200 {
		t.Fatalf("open dm: %d %v", code, body)
	}
	return body["channel"].(map[string]any)["id"].(string)
}

func (e *testEnv) send(t *testing.T, a account, chID, text string, extra map[string]any) map[string]any {
	t.Helper()
	payload := map[string]any{
		"suite": "kivora.x25519-xchacha20poly1305.v1",
		"body":  base64.StdEncoding.EncodeToString([]byte(text)),
		"keys":  map[string]string{a.deviceID: "AAAA"},
	}
	for k, v := range extra {
		payload[k] = v
	}
	code, body := e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", a.token, payload)
	if code != 200 {
		t.Fatalf("send: %d %v", code, body)
	}
	return body["message"].(map[string]any)
}

// ---------------------------------------------------------------- uploads

func TestUploadRoundTripAndAccessControl(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")
	chID := e.dm(t, alice, bob.userID)

	ciphertext := []byte("this-is-an-encrypted-photo")
	code, body := e.raw(t, "POST",
		"/api/v1/uploads?channel="+chID+"&mime=image/jpeg&w=800&h=600",
		alice.token, "application/octet-stream", ciphertext)
	if code != 200 {
		t.Fatalf("upload: %d %v", code, body)
	}
	upload := body["upload"].(map[string]any)
	uploadID := upload["id"].(string)
	if upload["size"].(float64) != float64(len(ciphertext)) {
		t.Errorf("size = %v", upload["size"])
	}
	if upload["width"].(float64) != 800 {
		t.Errorf("width was not kept: %v", upload["width"])
	}

	// A member downloads the exact bytes back.
	code, data, header := e.bytes(t, "/api/v1/uploads/"+uploadID, bob.token)
	if code != 200 || !bytes.Equal(data, ciphertext) {
		t.Fatalf("download: %d, %q", code, data)
	}
	if header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("downloads must be marked nosniff")
	}
	if !strings.Contains(header.Get("Content-Type"), "octet-stream") {
		t.Errorf("content type = %q, want octet-stream", header.Get("Content-Type"))
	}

	// An outsider cannot.
	if code, _, _ := e.bytes(t, "/api/v1/uploads/"+uploadID, mallory.token); code != http.StatusForbidden {
		t.Errorf("outsider downloaded a file: %d", code)
	}
	if code, _, _ := e.bytes(t, "/api/v1/uploads/"+uploadID, ""); code != http.StatusUnauthorized {
		t.Errorf("anonymous download allowed: %d", code)
	}
}

func TestUploadRejectsForeignChannelAndBadMime(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")
	chID := e.dm(t, alice, bob.userID)

	if code, _ := e.raw(t, "POST", "/api/v1/uploads?channel="+chID+"&mime=image/png",
		mallory.token, "application/octet-stream", []byte("x")); code != http.StatusForbidden {
		t.Errorf("outsider uploaded into a chat: %d", code)
	}
	// Types a browser might execute are refused even though the bytes are opaque.
	for _, mime := range []string{"text/html", "image/svg+xml", "application/javascript", ""} {
		if code, _ := e.raw(t, "POST", "/api/v1/uploads?channel="+chID+"&mime="+mime,
			alice.token, "application/octet-stream", []byte("x")); code != http.StatusBadRequest {
			t.Errorf("mime %q accepted: %d", mime, code)
		}
	}
}

func TestMessageCannotAdoptAnotherChatsUpload(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	carol := e.signUp(t, "carol")
	chatAB := e.dm(t, alice, bob.userID)
	chatAC := e.dm(t, alice, carol.userID)

	_, body := e.raw(t, "POST", "/api/v1/uploads?channel="+chatAB+"&mime=image/png",
		alice.token, "application/octet-stream", []byte("secret-photo"))
	uploadID := body["upload"].(map[string]any)["id"].(string)

	// Same uploader, different channel: still refused.
	code, _ := e.do(t, "POST", "/api/v1/channels/"+chatAC+"/messages", alice.token, map[string]any{
		"suite": "kivora.x25519-xchacha20poly1305.v1",
		"body":  base64.StdEncoding.EncodeToString([]byte("look")),
		"keys":  map[string]string{alice.deviceID: "AAAA"},
		// referencing the other chat's file
		"attachments": []string{uploadID},
	})
	if code != http.StatusBadRequest {
		t.Errorf("attachment from another chat accepted: %d", code)
	}
}

func TestAvatarUploadValidatesMagicBytes(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")

	// Claiming PNG while sending something else is refused.
	if code, _ := e.raw(t, "POST", "/api/v1/uploads/avatar?mime=image/png",
		alice.token, "application/octet-stream", []byte("not really a png at all")); code != http.StatusBadRequest {
		t.Errorf("bogus png accepted: %d", code)
	}

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	code, body := e.raw(t, "POST", "/api/v1/uploads/avatar?mime=image/png",
		alice.token, "application/octet-stream", png)
	if code != 200 {
		t.Fatalf("avatar upload: %d %v", code, body)
	}
	avatarID := body["upload"].(map[string]any)["id"].(string)

	code, _ = e.do(t, "PATCH", "/api/v1/me", alice.token, map[string]any{
		"displayName": "Alice", "bio": "", "avatar": avatarID,
	})
	if code != 200 {
		t.Fatalf("attach avatar: %d", code)
	}
	_, me := e.do(t, "GET", "/api/v1/me", alice.token, nil)
	if me["user"].(map[string]any)["avatar"] != avatarID {
		t.Error("avatar was not stored on the profile")
	}

	code, data, header := e.bytes(t, "/api/v1/avatars/"+avatarID, alice.token)
	if code != 200 || !bytes.Equal(data, png) {
		t.Fatalf("avatar fetch: %d", code)
	}
	if header.Get("Content-Type") != "image/png" {
		t.Errorf("content type = %q", header.Get("Content-Type"))
	}
}

func TestAvatarCannotBeStolen(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	_, body := e.raw(t, "POST", "/api/v1/uploads/avatar?mime=image/png",
		alice.token, "application/octet-stream", png)
	aliceAvatar := body["upload"].(map[string]any)["id"].(string)

	code, _ := e.do(t, "PATCH", "/api/v1/me", bob.token, map[string]any{
		"displayName": "Bob", "bio": "", "avatar": aliceAvatar,
	})
	if code != http.StatusBadRequest {
		t.Errorf("bob wore alice's avatar: %d", code)
	}
}

// ------------------------------------------------------------------- pins

func TestPinning(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")
	chID := e.dm(t, alice, bob.userID)

	m := e.send(t, alice, chID, "read this first", nil)
	msgID := m["id"].(string)

	if code, _ := e.do(t, "POST", "/api/v1/messages/"+msgID+"/pin", mallory.token, nil); code == 200 {
		t.Error("an outsider pinned a message")
	}
	if code, _ := e.do(t, "POST", "/api/v1/messages/"+msgID+"/pin", bob.token, nil); code != 200 {
		t.Fatal("a member could not pin")
	}

	_, body := e.do(t, "GET", "/api/v1/channels/"+chID+"/pinned", bob.token, nil)
	if len(body["messages"].([]any)) != 1 {
		t.Fatalf("pinned list: %v", body)
	}
	_, list := e.do(t, "GET", "/api/v1/channels", alice.token, nil)
	if got := list["channels"].([]any)[0].(map[string]any)["pinnedCount"].(float64); got != 1 {
		t.Errorf("pinnedCount = %v, want 1", got)
	}

	if code, _ := e.do(t, "DELETE", "/api/v1/messages/"+msgID+"/pin", alice.token, nil); code != 200 {
		t.Fatal("unpin failed")
	}
	_, body = e.do(t, "GET", "/api/v1/channels/"+chID+"/pinned", bob.token, nil)
	if len(body["messages"].([]any)) != 0 {
		t.Error("message stayed pinned")
	}

	// Deleting a pinned message must also unpin it.
	m2 := e.send(t, alice, chID, "second", nil)
	id2 := m2["id"].(string)
	e.do(t, "POST", "/api/v1/messages/"+id2+"/pin", alice.token, nil)
	e.do(t, "DELETE", "/api/v1/messages/"+id2, alice.token, nil)
	_, body = e.do(t, "GET", "/api/v1/channels/"+chID+"/pinned", bob.token, nil)
	if len(body["messages"].([]any)) != 0 {
		t.Error("a deleted message is still pinned")
	}
}

// ------------------------------------------------------- personal chat state

func TestMembershipFlagsArePersonal(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	chID := e.dm(t, alice, bob.userID)

	code, _ := e.do(t, "PATCH", "/api/v1/channels/"+chID+"/membership", alice.token,
		map[string]any{"archived": true, "pinned": true})
	if code != 200 {
		t.Fatalf("membership patch: %d", code)
	}

	_, aliceList := e.do(t, "GET", "/api/v1/channels", alice.token, nil)
	a := aliceList["channels"].([]any)[0].(map[string]any)
	if a["archived"] != true || a["pinned"] != true {
		t.Errorf("alice's flags did not stick: %v", a)
	}

	_, bobList := e.do(t, "GET", "/api/v1/channels", bob.token, nil)
	b := bobList["channels"].([]any)[0].(map[string]any)
	if b["archived"] == true {
		t.Error("archiving a chat archived it for the other person too")
	}
}

func TestClearHistoryOnlyRemovesOwnMessages(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	chID := e.dm(t, alice, bob.userID)

	e.send(t, alice, chID, "from alice", nil)
	e.send(t, bob, chID, "from bob", nil)

	if code, _ := e.do(t, "POST", "/api/v1/channels/"+chID+"/clear", alice.token, nil); code != 200 {
		t.Fatal("clear failed")
	}
	_, body := e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", bob.token, nil)
	msgs := body["messages"].([]any)
	deleted, alive := 0, 0
	for _, raw := range msgs {
		if raw.(map[string]any)["deleted"] == true {
			deleted++
		} else {
			alive++
		}
	}
	if deleted != 1 || alive != 1 {
		t.Errorf("clear removed the wrong set: %d deleted, %d alive", deleted, alive)
	}
}

// ---------------------------------------------------------------- threads

func TestThreadsAreNarrowerThanTheirGroup(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	carol := e.signUp(t, "carol")

	_, body := e.do(t, "POST", "/api/v1/channels", alice.token, map[string]any{
		"kind": "group", "name": "Проект", "topic": "",
		"members": []string{bob.userID, carol.userID},
		"suite":   "kivora.x25519-xchacha20poly1305.v1", "encrypted": true,
	})
	groupID := body["channel"].(map[string]any)["id"].(string)

	code, body := e.do(t, "POST", "/api/v1/channels/"+groupID+"/threads", alice.token, map[string]any{
		"name": "Только для двоих", "members": []string{bob.userID},
	})
	if code != 200 {
		t.Fatalf("create thread: %d %v", code, body)
	}
	thread := body["thread"].(map[string]any)
	threadID := thread["id"].(string)
	if thread["parentId"] != groupID {
		t.Error("thread lost its parent")
	}
	if thread["encrypted"] != true {
		t.Error("threads must always be encrypted")
	}

	// Alice and Bob see it; Carol does not.
	_, list := e.do(t, "GET", "/api/v1/channels/"+groupID+"/threads", bob.token, nil)
	if len(list["threads"].([]any)) != 1 {
		t.Error("bob cannot see the thread he was added to")
	}
	_, list = e.do(t, "GET", "/api/v1/channels/"+groupID+"/threads", carol.token, nil)
	if len(list["threads"].([]any)) != 0 {
		t.Error("carol can see a thread she was not added to")
	}
	if code, _ := e.do(t, "GET", "/api/v1/channels/"+threadID+"/messages", carol.token, nil); code != http.StatusForbidden {
		t.Errorf("carol read a thread she is not in: %d", code)
	}

	// Threads stay out of the sidebar; they are listed inside the group.
	_, chans := e.do(t, "GET", "/api/v1/channels", alice.token, nil)
	for _, raw := range chans["channels"].([]any) {
		if raw.(map[string]any)["kind"] == "thread" {
			t.Error("a thread leaked into the chat list")
		}
	}
	for _, raw := range chans["channels"].([]any) {
		c := raw.(map[string]any)
		if c["id"] == groupID && c["threadCount"].(float64) != 1 {
			t.Errorf("threadCount = %v, want 1", c["threadCount"])
		}
	}
}

func TestThreadMembersMustBeInTheGroup(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	outsider := e.signUp(t, "mallory")

	_, body := e.do(t, "POST", "/api/v1/channels", alice.token, map[string]any{
		"kind": "group", "name": "Группа", "topic": "",
		"members": []string{bob.userID},
		"suite":   "kivora.x25519-xchacha20poly1305.v1", "encrypted": true,
	})
	groupID := body["channel"].(map[string]any)["id"].(string)

	_, body = e.do(t, "POST", "/api/v1/channels/"+groupID+"/threads", alice.token, map[string]any{
		"name": "Ветка", "members": []string{outsider.userID},
	})
	members := body["thread"].(map[string]any)["members"].([]any)
	for _, raw := range members {
		if raw.(map[string]any)["userId"] == outsider.userID {
			t.Fatal("someone outside the group was added to its thread")
		}
	}
}

// ------------------------------------------------------------------ admin

func TestAdminAccessAndActions(t *testing.T) {
	e := newEnv(t)
	admin := e.signUp(t, "alice") // first account is the administrator
	user := e.signUp(t, "bob")

	if code, _ := e.do(t, "GET", "/api/v1/admin/overview", user.token, nil); code != http.StatusForbidden {
		t.Errorf("a normal user reached the admin API: %d", code)
	}

	code, overview := e.do(t, "GET", "/api/v1/admin/overview", admin.token, nil)
	if code != 200 {
		t.Fatalf("overview: %d %v", code, overview)
	}
	if overview["users"].(float64) != 2 {
		t.Errorf("users = %v, want 2", overview["users"])
	}
	if len(overview["messagesPerDay"].([]any)) != 7 {
		t.Error("the activity series should cover seven days")
	}
	if _, ok := overview["policy"]; !ok {
		t.Error("overview should report the server policy")
	}

	// Promote, then suspend.
	code, _ = e.do(t, "POST", "/api/v1/admin/users/"+user.userID+"/flags", admin.token,
		map[string]any{"isAdmin": true})
	if code != 200 {
		t.Fatalf("promote: %d", code)
	}
	if code, _ := e.do(t, "GET", "/api/v1/admin/overview", user.token, nil); code != 200 {
		t.Error("a promoted user still cannot reach the admin API")
	}

	code, _ = e.do(t, "POST", "/api/v1/admin/users/"+user.userID+"/flags", admin.token,
		map[string]any{"isAdmin": false, "suspended": true})
	if code != 200 {
		t.Fatalf("suspend: %d", code)
	}
	// A suspension takes effect at once. The live sessions are deleted, so the
	// old token comes back as invalid rather than as forbidden — either way it
	// stops working, which is what matters.
	if code, _ := e.do(t, "GET", "/api/v1/me", user.token, nil); code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Errorf("suspended user still authenticated: %d", code)
	}
	if code, _ := e.do(t, "POST", "/api/v1/auth/login", "", map[string]any{
		"username": "bob", "password": "correct horse battery staple",
	}); code != http.StatusForbidden {
		t.Errorf("suspended user could log in again: %d", code)
	}
}

func TestLastAdminCannotBeRemoved(t *testing.T) {
	e := newEnv(t)
	admin := e.signUp(t, "alice")

	code, body := e.do(t, "POST", "/api/v1/admin/users/"+admin.userID+"/flags", admin.token,
		map[string]any{"isAdmin": false})
	if code != http.StatusConflict {
		t.Fatalf("the last administrator demoted themselves: %d %v", code, body)
	}
	code, _ = e.do(t, "POST", "/api/v1/admin/users/"+admin.userID+"/flags", admin.token,
		map[string]any{"suspended": true})
	if code != http.StatusConflict {
		t.Fatalf("the last administrator suspended themselves: %d", code)
	}
}

func TestAdminChannelListCarriesNoContent(t *testing.T) {
	e := newEnv(t)
	admin := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	chID := e.dm(t, admin, bob.userID)
	e.send(t, admin, chID, "ciphertext-only", nil)

	_, body := e.do(t, "GET", "/api/v1/admin/channels", admin.token, nil)
	rows := body["channels"].([]any)
	if len(rows) == 0 {
		t.Fatal("no channels listed")
	}
	for _, raw := range rows {
		row := raw.(map[string]any)
		if _, ok := row["lastMessage"]; ok {
			t.Error("the admin list should not carry message payloads at all")
		}
		if row["id"] == chID && row["messageCount"].(float64) != 1 {
			t.Errorf("messageCount = %v", row["messageCount"])
		}
	}
}

func TestICEConfigRequiresAuth(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")

	if code, _ := e.do(t, "GET", "/api/v1/ice", "", nil); code != http.StatusUnauthorized {
		t.Errorf("ICE config is public: %d", code)
	}
	code, body := e.do(t, "GET", "/api/v1/ice", alice.token, nil)
	if code != 200 {
		t.Fatalf("ice: %d", code)
	}
	if len(body["iceServers"].([]any)) == 0 {
		t.Error("a STUN server should be configured by default")
	}
}

// dialWS opens an authenticated socket and swallows the `ready` handshake, so
// the caller's first read is the event it actually cares about.
func dialWS(t *testing.T, host, token string) *ws.Conn {
	t.Helper()
	conn, _, err := ws.Dial("ws://"+host+"/api/v1/ws?token="+token, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	if _, data, err := conn.Read(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("ready: %v", err)
	} else if !bytes.Contains(data, []byte(`"ready"`)) {
		t.Fatalf("expected ready, got %s", data)
	}
	return conn
}

// waitFor reads until an event of the given type arrives, or the deadline
// passes. Other events (presence, call.state) are expected and skipped.
func waitFor(t *testing.T, conn *ws.Conn, typ string) json.RawMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, data, err := conn.Read(deadline)
		if err != nil {
			t.Fatalf("waiting for %s: %v", typ, err)
		}
		var ev struct {
			Type    string          `json:"type"`
			Channel string          `json:"channel"`
			Data    json.RawMessage `json:"data"`
		}
		if json.Unmarshal(data, &ev) != nil || ev.Type != typ {
			continue
		}
		return ev.Data
	}
}

func pushWS(t *testing.T, conn *ws.Conn, typ, channel string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"type": typ, "channel": channel})
	if err := conn.Write(ws.OpText, payload); err != nil {
		t.Fatalf("push %s: %v", typ, err)
	}
}

// Declining a call has to reach the caller.
//
// It used to be a purely local dismissal: the callee's banner disappeared and
// the caller kept ringing at a room nobody was going to join. "No" is an
// answer, so it travels.
func TestDeclineReachesTheCaller(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	caller := dialWS(t, e.host, alice.token)
	defer caller.Close(ws.StatusNormalClosure, "")
	callee := dialWS(t, e.host, bob.token)
	defer callee.Close(ws.StatusNormalClosure, "")

	go func() {
		time.Sleep(50 * time.Millisecond)
		pushWS(t, callee, "call.decline", chID)
	}()

	data := waitFor(t, caller, "call.decline")
	var got struct {
		From string `json:"from"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.From != bob.userID {
		t.Fatalf("decline came from %q, want bob (%q)", got.From, bob.userID)
	}
}

// A decline must not be a way to poke a channel you have nothing to do with.
// The same check guards call.leave, which used to be missing it entirely.
func TestCallEventsRequireMembership(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	watcher := dialWS(t, e.host, alice.token)
	defer watcher.Close(ws.StatusNormalClosure, "")
	outsider := dialWS(t, e.host, mallory.token)
	defer outsider.Close(ws.StatusNormalClosure, "")

	pushWS(t, outsider, "call.decline", chID)
	pushWS(t, outsider, "call.leave", chID)
	// A real event from a real member, sent afterwards: if the outsider's
	// events had been relayed they would arrive first, so seeing typing first
	// proves the other two were dropped.
	pushWS(t, outsider, "ping", "")
	go func() {
		time.Sleep(80 * time.Millisecond)
		bobConn := dialWS(t, e.host, bob.token)
		defer bobConn.Close(ws.StatusNormalClosure, "")
		pushWS(t, bobConn, "typing", chID)
		time.Sleep(200 * time.Millisecond)
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		_, data, err := watcher.Read(deadline)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var ev struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch ev.Type {
		case "call.decline", "call.state":
			t.Fatalf("a non-member's %s was relayed into the channel", ev.Type)
		case "typing":
			return // got the marker without seeing the outsider's events
		}
	}
}

// "Clear my messages" has to clear all of them.
//
// The first implementation read one page of the newest 5000 and stopped, so in
// a long-running chat the caller's older messages quietly survived and the
// reported count gave no hint. The count here is deliberately above that old
// cap, so reverting to any single-slice read fails this test rather than
// passing it by accident.
func TestClearHistorySweepsPastOnePage(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	// Seeded through the store rather than the API: posting 1200 messages over
	// HTTP would trip the rate limiter, which is a different feature's job.
	const total = 5200
	for i := 0; i < total; i++ {
		m := &store.Message{
			ID: fmt.Sprintf("m_seed_%04d", i), ChannelID: chID,
			SenderID: alice.userID, SenderDevice: alice.deviceID,
			Suite: "kivora.x25519-xchacha20poly1305.v1", Kind: "text",
			Body: []byte("ciphertext"),
		}
		if err := e.st.InsertMessage(context.Background(), m, map[string][]byte{
			alice.deviceID: []byte("k-a"), bob.deviceID: []byte("k-b"),
		}); err != nil {
			t.Fatalf("seeding message %d: %v", i, err)
		}
	}

	code, out := e.do(t, "POST", "/api/v1/channels/"+chID+"/clear", alice.token, nil)
	if code != http.StatusOK {
		t.Fatalf("clear: status %d", code)
	}
	if got := int(out["removed"].(float64)); got != total {
		t.Fatalf("removed %d of %d — the sweep stopped early", got, total)
	}

	// And nothing readable is left behind for the other side either.
	_, hist := e.do(t, "GET", "/api/v1/channels/"+chID+"/messages?limit=2000", bob.token, nil)
	for _, raw := range hist["messages"].([]any) {
		m := raw.(map[string]any)
		if deleted, _ := m["deleted"].(bool); !deleted {
			t.Fatalf("a message survived the clear: %v", m["id"])
		}
	}
}

// The security headers must not disable the features the app itself needs.
//
// Permissions-Policy used to deny camera and microphone outright, which reads
// as prudent and silently broke every call: getUserMedia rejects with a policy
// violation before the browser even asks the person. Locking them to this
// origin is the version that is both safe and functional.
func TestPermissionsPolicyAllowsCallsButNothingElse(t *testing.T) {
	e := newEnv(t)
	code, _ := e.do(t, "GET", "/api/v1/server", "", nil)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}

	res, err := http.Get(e.srv.URL + "/api/v1/server")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	policy := res.Header.Get("Permissions-Policy")
	if policy == "" {
		t.Fatal("Permissions-Policy header is missing")
	}
	for _, needed := range []string{"camera=(self)", "microphone=(self)"} {
		if !strings.Contains(policy, needed) {
			t.Errorf("calls need %s, got %q", needed, policy)
		}
	}
	for _, denied := range []string{"geolocation=()", "payment=()", "usb=()"} {
		if !strings.Contains(policy, denied) {
			t.Errorf("%s should stay denied, got %q", denied, policy)
		}
	}
}

// A disappearing message must actually disappear — and "disappear" has to mean
// the keys are gone, not that the client agreed to stop drawing it.
func TestExpiredMessagesLoseTheirKeys(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	// One second, so the test does not have to sleep for a realistic timer.
	if code, _ := e.do(t, "PATCH", "/api/v1/channels/"+chID+"/ttl", alice.token,
		map[string]any{"ttlSeconds": 1}); code != http.StatusOK {
		t.Fatalf("setting the timer: status %d", code)
	}

	// The server stamps CreatedAt itself — a client must not be able to
	// backdate a message into expiry — so the test moves the clock instead.
	m := &store.Message{
		ID: "m_ttl", ChannelID: chID, SenderID: alice.userID, SenderDevice: alice.deviceID,
		Suite: "kivora.x25519-xchacha20poly1305.v1", Kind: "text", Body: []byte("ciphertext"),
	}
	if err := e.st.InsertMessage(context.Background(), m, map[string][]byte{
		alice.deviceID: []byte("k-a"), bob.deviceID: []byte("k-b"),
	}); err != nil {
		t.Fatal(err)
	}

	// Readable before the sweep.
	_, before := e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", bob.token, nil)
	if got := len(before["messages"].([]any)); got != 1 {
		t.Fatalf("expected the message to be there first, saw %d", got)
	}

	later := time.Now().Add(10 * time.Second).UnixMilli()
	n, touched := e.st.ExpireMessages(later, 0)
	if n != 1 {
		t.Fatalf("the sweep removed %d messages, want 1", n)
	}
	if len(touched) != 1 || touched[0] != chID {
		t.Fatalf("the sweep reported channels %v, want [%s]", touched, chID)
	}

	_, after := e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", bob.token, nil)
	for _, raw := range after["messages"].([]any) {
		msg := raw.(map[string]any)
		if deleted, _ := msg["deleted"].(bool); !deleted {
			t.Fatal("an expired message is still live")
		}
		if _, ok := msg["wrappedKey"]; ok {
			t.Fatal("an expired message kept its wrapped key — it is only hidden, not gone")
		}
	}
}

// The installation-wide retention limit and a chat's own timer both apply, and
// the earlier deadline wins. An operator's 30 days must not keep alive a chat
// that asked for an hour, and a chat's year must not outlive the operator's limit.
func TestTheEarlierDeadlineWins(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	insert := func(id string) {
		t.Helper()
		m := &store.Message{
			ID: id, ChannelID: chID, SenderID: alice.userID, SenderDevice: alice.deviceID,
			Suite: "kivora.x25519-xchacha20poly1305.v1", Kind: "text", Body: []byte("c"),
		}
		if err := e.st.InsertMessage(context.Background(), m, map[string][]byte{
			bob.deviceID: []byte("k"),
		}); err != nil {
			t.Fatal(err)
		}
	}

	// The chat wants a year; the operator allows an hour. The hour wins.
	if code, _ := e.do(t, "PATCH", "/api/v1/channels/"+chID+"/ttl", alice.token,
		map[string]any{"ttlSeconds": 365 * 24 * 3600}); code != http.StatusOK {
		t.Fatal("setting a long chat timer")
	}
	insert("m_old")
	insert("m_new")

	// Both messages exist now. Look at the world two hours from now with an
	// operator limit of one hour: both are past it, and both must go — the
	// chat's year does not survive the operator's hour.
	twoHoursOn := time.Now().Add(2 * time.Hour).UnixMilli()
	if n, _ := e.st.ExpireMessages(twoHoursOn, 3600); n != 2 {
		t.Fatalf("removed %d, want both — the operator limit must override the chat timer", n)
	}
	// And the other way round: a fresh chat whose own timer is short must
	// expire even though the operator set no limit at all.
	_, body2 := e.do(t, "POST", "/api/v1/channels", alice.token, map[string]any{
		"kind": "group", "name": "Быстрый", "members": []string{bob.userID},
		"suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	fastID := body2["channel"].(map[string]any)["id"].(string)
	if code, _ := e.do(t, "PATCH", "/api/v1/channels/"+fastID+"/ttl", alice.token,
		map[string]any{"ttlSeconds": 60}); code != http.StatusOK {
		t.Fatal("setting a short chat timer")
	}
	fast := &store.Message{
		ID: "m_fast", ChannelID: fastID, SenderID: alice.userID, SenderDevice: alice.deviceID,
		Suite: "kivora.x25519-xchacha20poly1305.v1", Kind: "text", Body: []byte("c"),
	}
	if err := e.st.InsertMessage(context.Background(), fast, map[string][]byte{
		bob.deviceID: []byte("k"),
	}); err != nil {
		t.Fatal(err)
	}
	fiveMinutesOn := time.Now().Add(5 * time.Minute).UnixMilli()
	if n, _ := e.st.ExpireMessages(fiveMinutesOn, 0); n != 1 {
		t.Fatalf("removed %d with no operator limit, want the chat's own timer to apply", n)
	}
}
