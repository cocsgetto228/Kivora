// Package ws is a small RFC 6455 WebSocket server.
//
// It exists for the same reason internal/crypto does: the server takes no
// third-party dependencies, and the subset of WebSocket a chat application
// needs — text frames, ping/pong, close, and the fragmentation rules — is a few
// hundred lines that can be read in one sitting and tested against itself.
//
// Deliberately not implemented: permessage-deflate. Compressing attacker-
// influenced data next to secret data is how CRIME and BREACH happened, and
// Kivora payloads are ciphertext, which does not compress anyway.
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const magicGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type Opcode byte

const (
	opContinuation Opcode = 0x0
	OpText         Opcode = 0x1
	OpBinary       Opcode = 0x2
	opClose        Opcode = 0x8
	opPing         Opcode = 0x9
	opPong         Opcode = 0xA
)

type StatusCode uint16

const (
	StatusNormalClosure   StatusCode = 1000
	StatusGoingAway       StatusCode = 1001
	StatusProtocolError   StatusCode = 1002
	StatusUnsupportedData StatusCode = 1003
	StatusPolicyViolation StatusCode = 1008
	StatusMessageTooBig   StatusCode = 1009
	StatusInternalError   StatusCode = 1011
)

var (
	ErrClosed       = errors.New("ws: connection closed")
	ErrHandshake    = errors.New("ws: bad handshake")
	ErrOriginDenied = errors.New("ws: origin not allowed")
)

type AcceptOptions struct {
	// OriginPatterns lists host patterns allowed to open a socket. A request
	// with no Origin (a native client) is always allowed; a browser request
	// with a foreign Origin is not. Leaving this empty means same-host only,
	// which is the safe default — cross-site WebSocket hijacking is real.
	OriginPatterns []string
	// ReadLimit caps a single message. 0 means 1 MiB.
	ReadLimit int64
}

type Conn struct {
	rw   net.Conn
	br   *bufio.Reader
	bw   *bufio.Writer
	lim  int64
	wmu  sync.Mutex
	rmu  sync.Mutex
	once sync.Once
	done chan struct{}

	// clientMode flips the two places where RFC 6455 is asymmetric: clients
	// must mask what they send, servers must not.
	clientMode bool
}

// Accept performs the server side of the handshake and hijacks the connection.
func Accept(w http.ResponseWriter, r *http.Request, opts *AcceptOptions) (*Conn, error) {
	if opts == nil {
		opts = &AcceptOptions{}
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!headerContainsToken(r.Header, "Connection", "upgrade") {
		return nil, ErrHandshake
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		w.Header().Set("Sec-WebSocket-Version", "13")
		return nil, ErrHandshake
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, ErrHandshake
	}
	if err := checkOrigin(r, opts.OriginPatterns); err != nil {
		return nil, err
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("ws: response writer does not support hijacking")
	}
	netConn, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	accept := acceptKey(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := brw.WriteString(resp); err != nil {
		netConn.Close()
		return nil, err
	}
	if err := brw.Flush(); err != nil {
		netConn.Close()
		return nil, err
	}

	limit := opts.ReadLimit
	if limit <= 0 {
		limit = 1 << 20
	}
	return &Conn{
		rw: netConn, br: brw.Reader, bw: bufio.NewWriter(netConn),
		lim: limit, done: make(chan struct{}),
	}, nil
}

func acceptKey(key string) string {
	h := sha1.New()
	io.WriteString(h, key+magicGUID)
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func headerContainsToken(h http.Header, name, token string) bool {
	for _, v := range h.Values(name) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func checkOrigin(r *http.Request, patterns []string) error {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return nil // not a browser
	}
	host := stripScheme(origin)
	if strings.EqualFold(host, r.Host) {
		return nil
	}
	for _, p := range patterns {
		if p == "*" || strings.EqualFold(stripScheme(p), host) {
			return nil
		}
	}
	return fmt.Errorf("%w: %s", ErrOriginDenied, origin)
}

func stripScheme(s string) string {
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	return strings.TrimSuffix(s, "/")
}

// ---------------------------------------------------------------- reading

type frame struct {
	fin    bool
	opcode Opcode
	data   []byte
}

func (c *Conn) readFrame(deadline time.Time) (frame, error) {
	if !deadline.IsZero() {
		_ = c.rw.SetReadDeadline(deadline)
	}
	var head [2]byte
	if _, err := io.ReadFull(c.br, head[:]); err != nil {
		return frame{}, err
	}
	f := frame{
		fin:    head[0]&0x80 != 0,
		opcode: Opcode(head[0] & 0x0F),
	}
	if head[0]&0x70 != 0 {
		return frame{}, errors.New("ws: reserved bits set")
	}
	masked := head[1]&0x80 != 0
	if !masked && !c.clientMode {
		// RFC 6455: every client-to-server frame must be masked.
		return frame{}, errors.New("ws: unmasked client frame")
	}
	if masked && c.clientMode {
		return frame{}, errors.New("ws: masked server frame")
	}
	length := int64(head[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return frame{}, err
		}
		length = int64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return frame{}, err
		}
		length = int64(binary.BigEndian.Uint64(ext[:]))
	}
	if length < 0 || length > c.lim {
		return frame{}, fmt.Errorf("ws: frame of %d bytes exceeds limit", length)
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return frame{}, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return frame{}, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	f.data = payload
	return f, nil
}

// Read returns the next complete application message, transparently answering
// pings and reassembling fragments.
func (c *Conn) Read(deadline time.Time) (Opcode, []byte, error) {
	c.rmu.Lock()
	defer c.rmu.Unlock()

	var (
		buf    []byte
		kind   Opcode
		inFrag bool
	)
	for {
		f, err := c.readFrame(deadline)
		if err != nil {
			return 0, nil, err
		}
		switch f.opcode {
		case opPing:
			if err := c.write(opPong, f.data); err != nil {
				return 0, nil, err
			}
		case opPong:
			// Nothing to do: liveness is tracked by the write side.
		case opClose:
			code := StatusNormalClosure
			if len(f.data) >= 2 {
				code = StatusCode(binary.BigEndian.Uint16(f.data[:2]))
			}
			_ = c.write(opClose, closePayload(code, ""))
			c.shutdown()
			return 0, nil, ErrClosed
		case OpText, OpBinary:
			if inFrag {
				return 0, nil, errors.New("ws: interleaved data frame")
			}
			kind = f.opcode
			if f.fin {
				return kind, f.data, nil
			}
			inFrag = true
			buf = append(buf, f.data...)
		case opContinuation:
			if !inFrag {
				return 0, nil, errors.New("ws: unexpected continuation")
			}
			buf = append(buf, f.data...)
			if int64(len(buf)) > c.lim {
				return 0, nil, errors.New("ws: fragmented message exceeds limit")
			}
			if f.fin {
				return kind, buf, nil
			}
		default:
			return 0, nil, fmt.Errorf("ws: unknown opcode %d", f.opcode)
		}
	}
}

// ---------------------------------------------------------------- writing

func (c *Conn) write(op Opcode, payload []byte) error {
	select {
	case <-c.done:
		return ErrClosed
	default:
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()

	head := make([]byte, 0, 14)
	head = append(head, 0x80|byte(op)) // frames written here are never fragmented
	n := len(payload)
	maskBit := byte(0)
	if c.clientMode {
		maskBit = 0x80
	}
	switch {
	case n < 126:
		head = append(head, maskBit|byte(n))
	case n <= 0xFFFF:
		head = append(head, maskBit|126, byte(n>>8), byte(n))
	default:
		head = append(head, maskBit|127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		head = append(head, ext[:]...)
	}
	body := payload
	if c.clientMode {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		head = append(head, mask[:]...)
		body = make([]byte, n)
		for i := range payload {
			body[i] = payload[i] ^ mask[i%4]
		}
	}
	_ = c.rw.SetWriteDeadline(time.Now().Add(20 * time.Second))
	if _, err := c.bw.Write(head); err != nil {
		return err
	}
	if _, err := c.bw.Write(body); err != nil {
		return err
	}
	return c.bw.Flush()
}

func (c *Conn) Write(op Opcode, payload []byte) error { return c.write(op, payload) }
func (c *Conn) Ping() error                           { return c.write(opPing, nil) }

func (c *Conn) Close(code StatusCode, reason string) error {
	err := c.write(opClose, closePayload(code, reason))
	c.shutdown()
	return err
}

func (c *Conn) shutdown() {
	c.once.Do(func() {
		close(c.done)
		_ = c.rw.Close()
	})
}

func closePayload(code StatusCode, reason string) []byte {
	if len(reason) > 123 {
		reason = reason[:123]
	}
	b := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(b, uint16(code))
	copy(b[2:], reason)
	return b
}

// ---------------------------------------------------------------- client

// Dial is a minimal client, used by the test suite to exercise the server
// end-to-end. It is not meant for production use.
func Dial(urlStr string, header http.Header) (*Conn, *http.Response, error) {
	u, err := parseWSURL(urlStr)
	if err != nil {
		return nil, nil, err
	}
	conn, err := net.DialTimeout("tcp", u.host, 10*time.Second)
	if err != nil {
		return nil, nil, err
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		conn.Close()
		return nil, nil, err
	}
	key := base64.StdEncoding.EncodeToString(raw)

	var sb strings.Builder
	fmt.Fprintf(&sb, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n", u.path, u.host)
	fmt.Fprintf(&sb, "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", key)
	for k, vs := range header {
		for _, v := range vs {
			fmt.Fprintf(&sb, "%s: %s\r\n", k, v)
		}
	}
	sb.WriteString("\r\n")
	if _, err := conn.Write([]byte(sb.String())); err != nil {
		conn.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		conn.Close()
		return nil, resp, fmt.Errorf("ws: unexpected status %d", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		conn.Close()
		return nil, resp, errors.New("ws: bad accept key")
	}
	return &Conn{rw: conn, br: br, bw: bufio.NewWriter(conn), lim: 1 << 20,
		done: make(chan struct{}), clientMode: true}, resp, nil
}

type wsURL struct{ host, path string }

func parseWSURL(s string) (wsURL, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "ws://"), "http://")
	i := strings.Index(s, "/")
	if i < 0 {
		return wsURL{host: s, path: "/"}, nil
	}
	return wsURL{host: s[:i], path: s[i:]}, nil
}
