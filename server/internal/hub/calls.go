package hub

import (
	"sync"
	"time"
)

// Call rooms.
//
// Kivora relays signalling and nothing else: the offers, answers and ICE
// candidates pass through here, while the audio and video go peer-to-peer (or
// through a TURN relay the operator runs). The server therefore knows who is in
// a call and when — the same metadata it already has for messages — and never
// touches the media itself.
//
// The registry is in-memory on purpose. A call does not survive a server
// restart in any useful sense, so persisting it would only create stale rooms
// nobody is in.

type Participant struct {
	UserID   string `json:"userId"`
	DeviceID string `json:"deviceId"`
	Video    bool   `json:"video"`
	Screen   bool   `json:"screen"`
	JoinedAt int64  `json:"joinedAt"`
}

type Room struct {
	ChannelID    string        `json:"channelId"`
	StartedAt    int64         `json:"startedAt"`
	Participants []Participant `json:"participants"`
}

type calls struct {
	mu    sync.RWMutex
	rooms map[string]map[string]*Participant // channel -> deviceID -> participant
	since map[string]int64
}

func newCalls() *calls {
	return &calls{rooms: map[string]map[string]*Participant{}, since: map[string]int64{}}
}

// Join adds a device to a room and reports the room afterwards. Joining twice
// from the same device updates the flags rather than creating a ghost.
func (h *Hub) Join(channelID, userID, deviceID string, video bool) Room {
	h.calls.mu.Lock()
	defer h.calls.mu.Unlock()
	room := h.calls.rooms[channelID]
	if room == nil {
		room = map[string]*Participant{}
		h.calls.rooms[channelID] = room
		h.calls.since[channelID] = time.Now().UnixMilli()
	}
	if existing, ok := room[deviceID]; ok {
		existing.Video = video
	} else {
		room[deviceID] = &Participant{
			UserID: userID, DeviceID: deviceID, Video: video,
			JoinedAt: time.Now().UnixMilli(),
		}
	}
	return h.roomLocked(channelID)
}

func (h *Hub) SetCallFlags(channelID, deviceID string, video, screen bool) Room {
	h.calls.mu.Lock()
	defer h.calls.mu.Unlock()
	if p, ok := h.calls.rooms[channelID][deviceID]; ok {
		p.Video, p.Screen = video, screen
	}
	return h.roomLocked(channelID)
}

func (h *Hub) Leave(channelID, deviceID string) Room {
	h.calls.mu.Lock()
	defer h.calls.mu.Unlock()
	if room, ok := h.calls.rooms[channelID]; ok {
		delete(room, deviceID)
		if len(room) == 0 {
			delete(h.calls.rooms, channelID)
			delete(h.calls.since, channelID)
		}
	}
	return h.roomLocked(channelID)
}

// LeaveAll is called when a socket dies: a dropped connection must not leave
// the caller listed in a call forever.
func (h *Hub) LeaveAll(deviceID string) []string {
	h.calls.mu.Lock()
	defer h.calls.mu.Unlock()
	var affected []string
	for channelID, room := range h.calls.rooms {
		if _, ok := room[deviceID]; !ok {
			continue
		}
		delete(room, deviceID)
		affected = append(affected, channelID)
		if len(room) == 0 {
			delete(h.calls.rooms, channelID)
			delete(h.calls.since, channelID)
		}
	}
	return affected
}

func (h *Hub) RoomOf(channelID string) Room {
	h.calls.mu.RLock()
	defer h.calls.mu.RUnlock()
	return h.roomLocked(channelID)
}

// ActiveRooms lists every channel with a live call, so a client that just
// connected learns what it can join.
func (h *Hub) ActiveRooms() []Room {
	h.calls.mu.RLock()
	defer h.calls.mu.RUnlock()
	out := make([]Room, 0, len(h.calls.rooms))
	for channelID := range h.calls.rooms {
		out = append(out, h.roomLocked(channelID))
	}
	return out
}

func (h *Hub) roomLocked(channelID string) Room {
	room := Room{ChannelID: channelID, StartedAt: h.calls.since[channelID], Participants: []Participant{}}
	for _, p := range h.calls.rooms[channelID] {
		room.Participants = append(room.Participants, *p)
	}
	return room
}
