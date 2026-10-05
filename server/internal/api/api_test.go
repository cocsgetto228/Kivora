package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kivora-im/kivora/server/internal/config"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/ws"
)

type testEnv struct {
	srv  *httptest.Server
	st   *store.Store
	host string
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("KIVORA_DATA_DIR", dir)
	t.Setenv("KIVORA_ARGON2_MEMORY_KIB", "1024") // keep the tests fast
	t.Setenv("KIVORA_ARGON2_TIME", "1")
	t.Setenv("KIVORA_CORS_ORIGINS", "*")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(store.Options{Dir: dir + "/db", Sync: store.SyncNever})
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := hub.New(log)
	srv := httptest.NewServer(New(cfg, st, h, log, nil).Handler())
	t.Cleanup(func() {
		srv.Close()
		st.Close()
	})
	return &testEnv{srv: srv, st: st, host: strings.TrimPrefix(srv.URL, "http://")}
}

func (e *testEnv) do(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

type account struct {
	token, userID, deviceID string
}

func (e *testEnv) signUp(t *testing.T, username string) account {
	t.Helper()
	code, body := e.do(t, "POST", "/api/v1/auth/register", "", map[string]any{
		"username": username, "displayName": strings.ToUpper(username[:1]) + username[1:],
		"password": "correct horse battery staple",
	})
	if code != 200 {
		t.Fatalf("register %s: %d %v", username, code, body)
	}
	token, _ := body["token"].(string)
	user, _ := body["user"].(map[string]any)
	userID, _ := user["id"].(string)

	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))
	code, body = e.do(t, "POST", "/api/v1/devices", token, map[string]any{
		"name": "test device", "platform": "linux",
		"suite":           "kivora.x25519-xchacha20poly1305.v1",
		"identityPub":     key,
		"signedPreKeyPub": key,
		"signedPreKeySig": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, 64)),
		"preKeys":         []map[string]string{{"id": "1", "pub": key}},
	})
	if code != 200 {
		t.Fatalf("device %s: %d %v", username, code, body)
	}
	dev, _ := body["device"].(map[string]any)
	deviceID, _ := dev["id"].(string)
	return account{token: token, userID: userID, deviceID: deviceID}
}

func TestServerInfoIsPublic(t *testing.T) {
	e := newEnv(t)
	code, body := e.do(t, "GET", "/api/v1/server", "", nil)
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	if body["name"] != "Kivora" {
		t.Fatalf("unexpected body %v", body)
	}
	if _, ok := body["suites"]; !ok {
		t.Fatal("server info should advertise cipher suites")
	}
}

func TestRegisterLoginAndSession(t *testing.T) {
	e := newEnv(t)
	a := e.signUp(t, "alice")

	// The first account registered owns the server.
	code, body := e.do(t, "GET", "/api/v1/me", a.token, nil)
	if code != 200 {
		t.Fatalf("me: %d", code)
	}
	user := body["user"].(map[string]any)
	if user["isAdmin"] != true {
		t.Error("first user should be admin")
	}
	if body["deviceId"] != a.deviceID {
		t.Error("session was not bound to the registered device")
	}

	// Duplicate usernames are refused.
	code, _ = e.do(t, "POST", "/api/v1/auth/register", "", map[string]any{
		"username": "alice", "password": "another password here",
	})
	if code != http.StatusConflict {
		t.Errorf("duplicate username: got %d, want 409", code)
	}

	// Wrong password is refused, right one works.
	code, _ = e.do(t, "POST", "/api/v1/auth/login", "", map[string]any{
		"username": "alice", "password": "wrong password entirely",
	})
	if code != http.StatusUnauthorized {
		t.Errorf("bad password: got %d, want 401", code)
	}
	code, body = e.do(t, "POST", "/api/v1/auth/login", "", map[string]any{
		"username": "alice", "password": "correct horse battery staple",
	})
	if code != 200 || body["token"] == "" {
		t.Fatalf("login failed: %d %v", code, body)
	}

	// Logout invalidates the token.
	code, _ = e.do(t, "POST", "/api/v1/auth/logout", a.token, nil)
	if code != 200 {
		t.Fatalf("logout: %d", code)
	}
	code, _ = e.do(t, "GET", "/api/v1/me", a.token, nil)
	if code != http.StatusUnauthorized {
		t.Errorf("token still valid after logout: %d", code)
	}
}

func TestUnauthenticatedAccessIsRefused(t *testing.T) {
	e := newEnv(t)
	for _, path := range []string{"/api/v1/me", "/api/v1/channels", "/api/v1/devices"} {
		if code, _ := e.do(t, "GET", path, "", nil); code != http.StatusUnauthorized {
			t.Errorf("%s without token: got %d, want 401", path, code)
		}
	}
	if code, _ := e.do(t, "GET", "/api/v1/me", "not-a-real-token", nil); code != http.StatusUnauthorized {
		t.Errorf("forged token accepted: %d", code)
	}
}

func TestDirectMessageRoundTrip(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	code, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	if code != 200 {
		t.Fatalf("open dm: %d %v", code, body)
	}
	ch := body["channel"].(map[string]any)
	chID := ch["id"].(string)

	// Opening it again must return the same conversation.
	_, body2 := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	if body2["channel"].(map[string]any)["id"] != chID {
		t.Error("opening a DM twice created two channels")
	}

	// Who must the sender wrap keys for?
	code, body = e.do(t, "GET", "/api/v1/channels/"+chID+"/devices", alice.token, nil)
	if code != 200 {
		t.Fatalf("devices: %d", code)
	}
	devices := body["devices"].([]any)
	if len(devices) != 2 {
		t.Fatalf("want 2 devices in the DM, got %d", len(devices))
	}

	cipher := base64.StdEncoding.EncodeToString([]byte("this-is-ciphertext"))
	keys := map[string]string{}
	for _, d := range devices {
		id := d.(map[string]any)["id"].(string)
		keys[id] = base64.StdEncoding.EncodeToString([]byte("wrapped-for-" + id))
	}
	code, body = e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", alice.token, map[string]any{
		"kind": "text", "suite": "kivora.x25519-xchacha20poly1305.v1",
		"body": cipher, "header": base64.StdEncoding.EncodeToString([]byte("hdr")),
		"keys": keys, "clientId": "c1",
	})
	if code != 200 {
		t.Fatalf("send: %d %v", code, body)
	}

	// Bob reads history and gets exactly his own wrapped key.
	code, body = e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", bob.token, nil)
	if code != 200 {
		t.Fatalf("history: %d %v", code, body)
	}
	msgs := body["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("want 1 message, got %d", len(msgs))
	}
	m := msgs[0].(map[string]any)
	if m["body"] != cipher {
		t.Error("ciphertext came back altered")
	}
	gotKey, _ := base64.StdEncoding.DecodeString(m["wrappedKey"].(string))
	if string(gotKey) != "wrapped-for-"+bob.deviceID {
		t.Errorf("bob got the wrong wrapped key: %s", gotKey)
	}
}

func TestOutsiderCannotReadOrPost(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	if code, _ := e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", mallory.token, nil); code != http.StatusForbidden {
		t.Errorf("outsider read history: got %d, want 403", code)
	}
	code, _ := e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", mallory.token, map[string]any{
		"suite": "kivora.x25519-xchacha20poly1305.v1",
		"body":  base64.StdEncoding.EncodeToString([]byte("x")),
		"keys":  map[string]string{mallory.deviceID: "AAAA"},
	})
	if code != http.StatusForbidden {
		t.Errorf("outsider posted: got %d, want 403", code)
	}
	if code, _ := e.do(t, "GET", "/api/v1/channels/"+chID+"/devices", mallory.token, nil); code != http.StatusForbidden {
		t.Errorf("outsider enumerated devices: got %d, want 403", code)
	}
}

// A sender must not be able to smuggle a key to a device outside the channel.
func TestKeysForNonMemberDevicesAreDropped(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	mallory := e.signUp(t, "mallory")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", alice.token, map[string]any{
		"suite": "kivora.x25519-xchacha20poly1305.v1",
		"body":  base64.StdEncoding.EncodeToString([]byte("secret")),
		"keys": map[string]string{
			alice.deviceID:   base64.StdEncoding.EncodeToString([]byte("k-alice")),
			bob.deviceID:     base64.StdEncoding.EncodeToString([]byte("k-bob")),
			mallory.deviceID: base64.StdEncoding.EncodeToString([]byte("k-mallory")),
		},
	})

	msg, err := e.st.History(t.Context(), chID, mallory.deviceID, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msg) != 1 {
		t.Fatalf("want 1 message, got %d", len(msg))
	}
	if msg[0].WrappedKey != nil {
		t.Error("a key was stored for a device outside the channel")
	}
}

func TestSuitePolicyIsEnforced(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIVORA_DATA_DIR", dir)
	t.Setenv("KIVORA_ARGON2_MEMORY_KIB", "1024")
	t.Setenv("KIVORA_ARGON2_TIME", "1")
	t.Setenv("KIVORA_ALLOWED_SUITES", "kivora.x25519-xchacha20poly1305.v1")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := store.Open(store.Options{Dir: dir + "/db", Sync: store.SyncNever})
	defer st.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(cfg, st, hub.New(log), log, nil).Handler())
	defer srv.Close()
	e := &testEnv{srv: srv, st: st}

	code, body := e.do(t, "POST", "/api/v1/auth/register", "", map[string]any{
		"username": "alice", "password": "correct horse battery staple",
	})
	if code != 200 {
		t.Fatal(body)
	}
	token := body["token"].(string)
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))

	// A suite the operator did not allow is refused...
	code, _ = e.do(t, "POST", "/api/v1/devices", token, map[string]any{
		"name": "d", "suite": "vendor.rot13.v1", "identityPub": key,
		"signedPreKeyPub": key, "signedPreKeySig": key,
	})
	if code != http.StatusBadRequest {
		t.Errorf("disallowed suite accepted: %d", code)
	}
	// ...and one that is not even a well-formed id is refused too.
	code, _ = e.do(t, "POST", "/api/v1/devices", token, map[string]any{
		"name": "d", "suite": "NOT A SUITE", "identityPub": key,
		"signedPreKeyPub": key, "signedPreKeySig": key,
	})
	if code != http.StatusBadRequest {
		t.Errorf("malformed suite accepted: %d", code)
	}
	// The allowed one works.
	code, _ = e.do(t, "POST", "/api/v1/devices", token, map[string]any{
		"name": "d", "suite": "kivora.x25519-xchacha20poly1305.v1", "identityPub": key,
		"signedPreKeyPub": key, "signedPreKeySig": key,
	})
	if code != 200 {
		t.Errorf("allowed suite refused: %d", code)
	}
}

func TestGroupChannelsAndBrowsing(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	code, body := e.do(t, "POST", "/api/v1/channels", alice.token, map[string]any{
		"kind": "channel", "name": "Общее", "topic": "everything else",
	})
	if code != 200 {
		t.Fatalf("create channel: %d %v", code, body)
	}
	ch := body["channel"].(map[string]any)
	if ch["slug"] != "общее" {
		t.Errorf("slug = %v, want cyrillic slug preserved", ch["slug"])
	}
	chID := ch["id"].(string)

	// Bob sees it in "browse" and can join a public channel himself.
	code, body = e.do(t, "GET", "/api/v1/channels/browse", bob.token, nil)
	if code != 200 || len(body["channels"].([]any)) != 1 {
		t.Fatalf("browse: %d %v", code, body)
	}
	if code, _ := e.do(t, "POST", "/api/v1/channels/"+chID+"/join", bob.token, nil); code != 200 {
		t.Fatalf("join: %d", code)
	}
	code, body = e.do(t, "GET", "/api/v1/channels", bob.token, nil)
	if code != 200 || len(body["channels"].([]any)) != 1 {
		t.Fatalf("bob's channel list: %d %v", code, body)
	}
	// Once joined it is no longer offered for browsing.
	_, body = e.do(t, "GET", "/api/v1/channels/browse", bob.token, nil)
	if len(body["channels"].([]any)) != 0 {
		t.Error("joined channel still shown in browse")
	}
}

func TestUnreadCounters(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	for i := 0; i < 3; i++ {
		e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", alice.token, map[string]any{
			"suite": "kivora.x25519-xchacha20poly1305.v1",
			"body":  base64.StdEncoding.EncodeToString([]byte("msg")),
			"keys":  map[string]string{bob.deviceID: "AAAA", alice.deviceID: "AAAA"},
		})
	}
	_, body = e.do(t, "GET", "/api/v1/channels", bob.token, nil)
	got := body["channels"].([]any)[0].(map[string]any)["unread"].(float64)
	if got != 3 {
		t.Errorf("bob unread = %v, want 3", got)
	}
	// The sender has read their own messages.
	_, body = e.do(t, "GET", "/api/v1/channels", alice.token, nil)
	if got := body["channels"].([]any)[0].(map[string]any)["unread"].(float64); got != 0 {
		t.Errorf("alice unread = %v, want 0", got)
	}

	e.do(t, "POST", "/api/v1/channels/"+chID+"/read", bob.token, map[string]any{"seq": 3})
	_, body = e.do(t, "GET", "/api/v1/channels", bob.token, nil)
	if got := body["channels"].([]any)[0].(map[string]any)["unread"].(float64); got != 0 {
		t.Errorf("unread after read marker = %v, want 0", got)
	}
}

func TestDeleteBurnsTheKeys(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")
	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	_, body = e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", alice.token, map[string]any{
		"suite": "kivora.x25519-xchacha20poly1305.v1",
		"body":  base64.StdEncoding.EncodeToString([]byte("regrettable")),
		"keys":  map[string]string{bob.deviceID: "AAAA", alice.deviceID: "AAAA"},
	})
	msgID := body["message"].(map[string]any)["id"].(string)

	// Bob cannot delete Alice's message.
	if code, _ := e.do(t, "DELETE", "/api/v1/messages/"+msgID, bob.token, nil); code == 200 {
		t.Error("bob deleted alice's message")
	}
	if code, _ := e.do(t, "DELETE", "/api/v1/messages/"+msgID, alice.token, nil); code != 200 {
		t.Fatal("alice could not delete her own message")
	}
	_, body = e.do(t, "GET", "/api/v1/channels/"+chID+"/messages", bob.token, nil)
	m := body["messages"].([]any)[0].(map[string]any)
	if m["deleted"] != true {
		t.Error("message not marked deleted")
	}
	if _, ok := m["wrappedKey"]; ok {
		t.Error("wrapped key survived deletion")
	}
}

func TestRealtimeDelivery(t *testing.T) {
	e := newEnv(t)
	alice := e.signUp(t, "alice")
	bob := e.signUp(t, "bob")

	_, body := e.do(t, "POST", "/api/v1/channels/direct", alice.token, map[string]any{
		"userId": bob.userID, "suite": "kivora.x25519-xchacha20poly1305.v1",
	})
	chID := body["channel"].(map[string]any)["id"].(string)

	conn, _, err := ws.Dial("ws://"+e.host+"/api/v1/ws?token="+bob.token, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(ws.StatusNormalClosure, "")

	// First frame is the ready handshake.
	if _, data, err := conn.Read(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("ready: %v", err)
	} else if !bytes.Contains(data, []byte(`"ready"`)) {
		t.Fatalf("expected ready event, got %s", data)
	}

	go func() {
		time.Sleep(50 * time.Millisecond)
		e.do(t, "POST", "/api/v1/channels/"+chID+"/messages", alice.token, map[string]any{
			"suite": "kivora.x25519-xchacha20poly1305.v1",
			"body":  base64.StdEncoding.EncodeToString([]byte("live")),
			"keys": map[string]string{
				bob.deviceID:   base64.StdEncoding.EncodeToString([]byte("k-bob")),
				alice.deviceID: base64.StdEncoding.EncodeToString([]byte("k-alice")),
			},
		})
	}()

	deadline := time.Now().Add(5 * time.Second)
	for {
		_, data, err := conn.Read(deadline)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var ev struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(data, &ev); err != nil {
			continue
		}
		if ev.Type != "message.new" {
			continue
		}
		var m store.Message
		if err := json.Unmarshal(ev.Data, &m); err != nil {
			t.Fatal(err)
		}
		if string(m.WrappedKey) != "k-bob" {
			t.Fatalf("bob received the wrong wrapped key: %q", m.WrappedKey)
		}
		return
	}
}

func TestRateLimiterKicksIn(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KIVORA_DATA_DIR", dir)
	t.Setenv("KIVORA_RATE_RPS", "1")
	t.Setenv("KIVORA_RATE_BURST", "5")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	st, _ := store.Open(store.Options{Dir: dir + "/db", Sync: store.SyncNever})
	defer st.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(cfg, st, hub.New(log), log, nil).Handler())
	defer srv.Close()
	e := &testEnv{srv: srv, st: st}

	limited := false
	for i := 0; i < 30; i++ {
		if code, _ := e.do(t, "GET", "/api/v1/server", "", nil); code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Error("rate limiter never triggered")
	}
}

func TestSecurityHeadersPresent(t *testing.T) {
	e := newEnv(t)
	resp, err := e.srv.Client().Get(e.srv.URL + "/api/v1/server")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	for _, h := range []string{"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
		if resp.Header.Get(h) == "" {
			t.Errorf("missing security header %s", h)
		}
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
