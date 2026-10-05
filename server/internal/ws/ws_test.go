package ws

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func echoServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Accept(w, r, &AcceptOptions{OriginPatterns: []string{"*"}, ReadLimit: 1 << 20})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer c.Close(StatusNormalClosure, "")
		for {
			op, data, err := c.Read(time.Now().Add(5 * time.Second))
			if err != nil {
				return
			}
			if err := c.Write(op, data); err != nil {
				return
			}
		}
	}))
	return srv, strings.TrimPrefix(srv.URL, "http://")
}

func TestHandshakeAndEcho(t *testing.T) {
	srv, host := echoServer(t)
	defer srv.Close()

	c, _, err := Dial("ws://"+host+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(StatusNormalClosure, "")

	for _, msg := range []string{"hello", "", strings.Repeat("x", 200), strings.Repeat("y", 70000)} {
		if err := c.Write(OpText, []byte(msg)); err != nil {
			t.Fatalf("write: %v", err)
		}
		op, got, err := c.Read(time.Now().Add(5 * time.Second))
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if op != OpText || string(got) != msg {
			t.Fatalf("echo mismatch: op=%d len=%d want len=%d", op, len(got), len(msg))
		}
	}
}

func TestBinaryFrames(t *testing.T) {
	srv, host := echoServer(t)
	defer srv.Close()
	c, _, err := Dial("ws://"+host+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(StatusNormalClosure, "")

	payload := make([]byte, 5000)
	for i := range payload {
		payload[i] = byte(i)
	}
	if err := c.Write(OpBinary, payload); err != nil {
		t.Fatal(err)
	}
	op, got, err := c.Read(time.Now().Add(5 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if op != OpBinary || !bytes.Equal(got, payload) {
		t.Fatal("binary round-trip failed")
	}
}

func TestAcceptKeyRFCExample(t *testing.T) {
	// The example from RFC 6455 section 1.3.
	if got := acceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("acceptKey = %q", got)
	}
}

func TestRejectsForeignOrigin(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := Accept(w, r, &AcceptOptions{OriginPatterns: []string{"app.example.com"}})
		if err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
		}
	}))
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")

	h := http.Header{}
	h.Set("Origin", "https://evil.example.net")
	if _, resp, err := Dial("ws://"+host+"/ws", h); err == nil {
		t.Fatal("foreign origin was accepted")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected status %d", resp.StatusCode)
	}

	h.Set("Origin", "https://app.example.com")
	c, _, err := Dial("ws://"+host+"/ws", h)
	if err != nil {
		t.Fatalf("allowed origin rejected: %v", err)
	}
	c.Close(StatusNormalClosure, "")
}

func TestPingIsAnsweredAutomatically(t *testing.T) {
	srv, host := echoServer(t)
	defer srv.Close()
	c, _, err := Dial("ws://"+host+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(StatusNormalClosure, "")
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}
	// The pong is consumed inside Read; a following echo must still work.
	if err := c.Write(OpText, []byte("after-ping")); err != nil {
		t.Fatal(err)
	}
	_, got, err := c.Read(time.Now().Add(5 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "after-ping" {
		t.Fatalf("got %q", got)
	}
}
