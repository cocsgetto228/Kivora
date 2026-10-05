// Package hub is the realtime fan-out. It knows nothing about message content:
// it moves opaque envelopes from one connection to the connections that are
// allowed to see them.
package hub

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/kivora-im/kivora/server/internal/ws"
)

type Event struct {
	Type    string          `json:"type"`
	Channel string          `json:"channel,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	TS      int64           `json:"ts"`
}

type Conn struct {
	UserID   string
	DeviceID string

	conn *ws.Conn
	send chan []byte
	once sync.Once
	done chan struct{}
}

type Hub struct {
	mu sync.RWMutex
	// byUser holds every live connection of a user (all their devices/tabs).
	byUser map[string]map[*Conn]struct{}
	log    *slog.Logger
	calls  *calls
}

func New(log *slog.Logger) *Hub {
	return &Hub{
		byUser: make(map[string]map[*Conn]struct{}),
		log:    log,
		calls:  newCalls(),
	}
}

func (h *Hub) Register(userID, deviceID string, conn *ws.Conn) *Conn {
	c := &Conn{
		UserID:   userID,
		DeviceID: deviceID,
		conn:     conn,
		send:     make(chan []byte, 64),
		done:     make(chan struct{}),
	}
	h.mu.Lock()
	if h.byUser[userID] == nil {
		h.byUser[userID] = make(map[*Conn]struct{})
	}
	h.byUser[userID][c] = struct{}{}
	h.mu.Unlock()
	go c.writePump(h.log)
	return c
}

func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	if set, ok := h.byUser[c.UserID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.byUser, c.UserID)
		}
	}
	h.mu.Unlock()
	c.close()
}

func (c *Conn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close(ws.StatusNormalClosure, "")
	})
}

func (c *Conn) writePump(_ *slog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case msg := <-c.send:
			if err := c.conn.Write(ws.OpText, msg); err != nil {
				c.close()
				return
			}
		case <-ticker.C:
			// A ping every 30s keeps proxies from dropping an idle chat
			// window and tells us quickly when a client vanished.
			if err := c.conn.Ping(); err != nil {
				c.close()
				return
			}
		}
	}
}

// Online reports whether a user has at least one live connection.
func (h *Hub) Online(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.byUser[userID]) > 0
}

func (h *Hub) OnlineUsers() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]string, 0, len(h.byUser))
	for id := range h.byUser {
		out = append(out, id)
	}
	return out
}

// ToUsers delivers an event to every connection of the listed users. A slow
// consumer is dropped rather than allowed to block the sender: realtime is a
// best-effort layer, the REST history is the source of truth.
func (h *Hub) ToUsers(userIDs []string, ev Event) {
	ev.TS = time.Now().UnixMilli()
	payload, err := json.Marshal(ev)
	if err != nil {
		h.log.Error("hub marshal", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, uid := range userIDs {
		for c := range h.byUser[uid] {
			select {
			case c.send <- payload:
			default:
				h.log.Warn("dropping slow websocket consumer", "user", uid, "device", c.DeviceID)
				go c.close()
			}
		}
	}
}

// ToUserDevices is the per-device variant: used for message delivery where each
// device gets a different wrapped key and must not see the others'.
func (h *Hub) ToUserDevices(userID string, per map[string]Event) {
	h.mu.RLock()
	conns := make([]*Conn, 0, len(h.byUser[userID]))
	for c := range h.byUser[userID] {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, c := range conns {
		ev, ok := per[c.DeviceID]
		if !ok {
			continue
		}
		ev.TS = time.Now().UnixMilli()
		payload, err := json.Marshal(ev)
		if err != nil {
			continue
		}
		select {
		case c.send <- payload:
		default:
			go c.close()
		}
	}
}

func (h *Hub) Except(userIDs []string, exclude string) []string {
	out := make([]string, 0, len(userIDs))
	for _, id := range userIDs {
		if id != exclude {
			out = append(out, id)
		}
	}
	return out
}

// ToDevice delivers an event to one specific device of one user. Call
// signalling needs this: an offer is meaningless to any device other than the
// one that will answer it, and fanning it out would ring every tab the person
// has open.
func (h *Hub) ToDevice(userID, deviceID string, ev Event) bool {
	ev.TS = time.Now().UnixMilli()
	payload, err := json.Marshal(ev)
	if err != nil {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.byUser[userID] {
		if c.DeviceID != deviceID {
			continue
		}
		select {
		case c.send <- payload:
			return true
		default:
			go c.close()
			return false
		}
	}
	return false
}
