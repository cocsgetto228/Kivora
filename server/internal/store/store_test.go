package store

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openTmp(t *testing.T, dir string) *Store {
	t.Helper()
	st, err := Open(Options{Dir: dir, Sync: SyncAlways})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func seed(t *testing.T, st *Store) (aliceID, bobID, chID, devA, devB string) {
	t.Helper()
	ctx := context.Background()
	alice := &User{ID: "u_alice", Username: "alice", DisplayName: "Alice"}
	bob := &User{ID: "u_bob", Username: "bob", DisplayName: "Bob"}
	for _, u := range []*User{alice, bob} {
		if err := st.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []*Device{
		{ID: "d_a", UserID: alice.ID, Name: "A", Suite: "s.v1", IdentityPub: []byte{1}},
		{ID: "d_b", UserID: bob.ID, Name: "B", Suite: "s.v1", IdentityPub: []byte{2}},
	} {
		if err := st.CreateDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	ch := &Channel{ID: "c_1", Kind: "dm", OwnerID: alice.ID, Encrypted: true, Suite: "s.v1"}
	if err := st.CreateChannel(ctx, ch, []string{alice.ID, bob.ID}); err != nil {
		t.Fatal(err)
	}
	return alice.ID, bob.ID, ch.ID, "d_a", "d_b"
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()

	st := openTmp(t, dir)
	aliceID, _, chID, devA, devB := seed(t, st)
	for i := 0; i < 5; i++ {
		m := &Message{ID: "m_" + string(rune('a'+i)), ChannelID: chID, SenderID: aliceID,
			SenderDevice: devA, Suite: "s.v1", Kind: "text", Body: []byte("ciphertext"), Header: []byte("hdr")}
		if err := st.InsertMessage(ctx, m, map[string][]byte{
			devA: []byte("key-a"), devB: []byte("key-b"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopen: everything must come back, including sequence numbers.
	st2 := openTmp(t, dir)
	defer st2.Close()

	msgs, err := st2.History(ctx, chID, devB, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 5 {
		t.Fatalf("want 5 messages after restart, got %d", len(msgs))
	}
	if msgs[0].Seq != 1 || msgs[4].Seq != 5 {
		t.Errorf("sequence numbers wrong after replay: %d..%d", msgs[0].Seq, msgs[4].Seq)
	}
	if !bytes.Equal(msgs[0].WrappedKey, []byte("key-b")) {
		t.Errorf("wrapped key lost: %q", msgs[0].WrappedKey)
	}
	if !bytes.Equal(msgs[0].Body, []byte("ciphertext")) {
		t.Error("body lost")
	}
	u, err := st2.UserByUsername(ctx, "alice")
	if err != nil || u.DisplayName != "Alice" {
		t.Errorf("user lost: %v %v", u, err)
	}
}

// A crash mid-write leaves a torn record. Replay must drop it and keep serving.
func TestTornTailIsTruncated(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()

	st := openTmp(t, dir)
	aliceID, _, chID, devA, devB := seed(t, st)
	m := &Message{ID: "m_1", ChannelID: chID, SenderID: aliceID, SenderDevice: devA,
		Suite: "s.v1", Kind: "text", Body: []byte("good")}
	if err := st.InsertMessage(ctx, m, map[string][]byte{devB: []byte("k")}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	// Append garbage, simulating a half-flushed record.
	path := filepath.Join(dir, "meta.log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	f.Write([]byte{0x40, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 'g', 'a', 'r', 'b'})
	f.Close()
	sizeBefore, _ := os.Stat(path)

	st2 := openTmp(t, dir)
	defer st2.Close()
	msgs, err := st2.History(ctx, chID, devB, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || string(msgs[0].Body) != "good" {
		t.Fatalf("clean records lost after torn tail: %+v", msgs)
	}
	sizeAfter, _ := os.Stat(path)
	if sizeAfter.Size() >= sizeBefore.Size() {
		t.Error("torn tail was not truncated")
	}

	// And the store must still be writable afterwards.
	m2 := &Message{ID: "m_2", ChannelID: chID, SenderID: aliceID, SenderDevice: devA,
		Suite: "s.v1", Kind: "text", Body: []byte("after recovery")}
	if err := st2.InsertMessage(ctx, m2, map[string][]byte{devB: []byte("k")}); err != nil {
		t.Fatal(err)
	}
	if msgs, _ := st2.History(ctx, chID, devB, 0, 10); len(msgs) != 2 {
		t.Fatalf("write after recovery lost: %d", len(msgs))
	}
}

func TestCompactionKeepsLiveDataAndDropsDeleted(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	st := openTmp(t, dir)
	aliceID, _, chID, devA, devB := seed(t, st)

	for i := 0; i < 10; i++ {
		m := &Message{ID: "m" + string(rune('0'+i)), ChannelID: chID, SenderID: aliceID,
			SenderDevice: devA, Suite: "s.v1", Kind: "text", Body: []byte("payload")}
		if err := st.InsertMessage(ctx, m, map[string][]byte{devB: []byte("k")}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 5; i++ {
		if err := st.DeleteMessage(ctx, "m"+string(rune('0'+i)), aliceID); err != nil {
			t.Fatal(err)
		}
	}
	beforeMeta, _ := os.Stat(filepath.Join(dir, "meta.log"))
	beforeBlob, _ := os.Stat(filepath.Join(dir, "blobs.dat"))

	if err := st.Compact(); err != nil {
		t.Fatal(err)
	}
	afterBlob, _ := os.Stat(filepath.Join(dir, "blobs.dat"))
	if afterBlob.Size() >= beforeBlob.Size() {
		t.Errorf("blob file did not shrink: %d -> %d", beforeBlob.Size(), afterBlob.Size())
	}
	_ = beforeMeta

	// Live messages survive compaction with their keys intact...
	msgs, err := st.History(ctx, chID, devB, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	live := 0
	for _, m := range msgs {
		if m.Deleted {
			continue
		}
		live++
		if string(m.Body) != "payload" || string(m.WrappedKey) != "k" {
			t.Errorf("message %s damaged by compaction: body=%q key=%q", m.ID, m.Body, m.WrappedKey)
		}
	}
	if live != 5 {
		t.Errorf("want 5 live messages, got %d", live)
	}
	st.Close()

	// ...and after a restart on the compacted files.
	st2 := openTmp(t, dir)
	defer st2.Close()
	msgs, _ = st2.History(ctx, chID, devB, 0, 50)
	live = 0
	for _, m := range msgs {
		if !m.Deleted {
			live++
			if string(m.Body) != "payload" {
				t.Error("body damaged after reopening compacted store")
			}
		}
	}
	if live != 5 {
		t.Errorf("after restart: want 5 live messages, got %d", live)
	}
}

func TestPreKeysAreConsumedOnce(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	seed(t, st)

	if err := st.AddPreKeys(ctx, "d_a", []string{"p1", "p2"}, [][]byte{{1}, {2}}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		id, pub, err := st.TakePreKey(ctx, "d_a")
		if err != nil || id == "" || len(pub) == 0 {
			t.Fatalf("take %d: %v %q", i, err, id)
		}
		if seen[id] {
			t.Fatalf("prekey %s handed out twice", id)
		}
		seen[id] = true
	}
	// Exhausted pool is not an error: the handshake falls back.
	id, _, err := st.TakePreKey(ctx, "d_a")
	if err != nil || id != "" {
		t.Fatalf("exhausted pool: id=%q err=%v", id, err)
	}
	if n, _ := st.CountPreKeys(ctx, "d_a"); n != 0 {
		t.Errorf("count = %d, want 0", n)
	}
}

func TestRevokingADeviceKillsItsSessions(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	seed(t, st)

	if err := st.CreateSession(ctx, "hash1", "u_alice", "d_a", "ua", time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SessionByHash(ctx, "hash1"); err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeDevice(ctx, "u_alice", "d_a"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SessionByHash(ctx, "hash1"); err == nil {
		t.Error("session survived device revocation")
	}
	if n, _ := st.CountDevices(ctx, "u_alice"); n != 0 {
		t.Errorf("revoked device still counted: %d", n)
	}
}

func TestSessionExpiry(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	seed(t, st)

	_ = st.CreateSession(ctx, "expired", "u_alice", "d_a", "", -time.Minute)
	_ = st.CreateSession(ctx, "live", "u_alice", "d_a", "", time.Hour)
	if _, err := st.SessionByHash(ctx, "expired"); err == nil {
		t.Error("expired session accepted")
	}
	if _, err := st.SessionByHash(ctx, "live"); err != nil {
		t.Error("live session rejected")
	}
}

func TestBackfillGivesANewDeviceHistory(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	aliceID, _, chID, devA, devB := seed(t, st)

	m := &Message{ID: "m_1", ChannelID: chID, SenderID: aliceID, SenderDevice: devA,
		Suite: "s.v1", Kind: "text", Body: []byte("old message")}
	if err := st.InsertMessage(ctx, m, map[string][]byte{devA: []byte("ka"), devB: []byte("kb")}); err != nil {
		t.Fatal(err)
	}

	// Alice adds a second device; it starts with no key for the old message.
	newDev := &Device{ID: "d_a2", UserID: aliceID, Name: "laptop", Suite: "s.v1", IdentityPub: []byte{3}}
	if err := st.CreateDevice(ctx, newDev); err != nil {
		t.Fatal(err)
	}
	msgs, _ := st.History(ctx, chID, "d_a2", 0, 10)
	if msgs[0].WrappedKey != nil {
		t.Fatal("new device should not have a key yet")
	}

	if err := st.BackfillKeys(ctx, "d_a2", map[string][]byte{"m_1": []byte("ka2")}); err != nil {
		t.Fatal(err)
	}
	msgs, _ = st.History(ctx, chID, "d_a2", 0, 10)
	if string(msgs[0].WrappedKey) != "ka2" {
		t.Errorf("backfill failed: %q", msgs[0].WrappedKey)
	}
	// The other devices' keys are untouched.
	msgs, _ = st.History(ctx, chID, devB, 0, 10)
	if string(msgs[0].WrappedKey) != "kb" {
		t.Errorf("backfill clobbered another device's key: %q", msgs[0].WrappedKey)
	}
}

func TestHistoryPagination(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	aliceID, _, chID, devA, devB := seed(t, st)

	for i := 0; i < 25; i++ {
		m := &Message{ID: "m" + string(rune('A'+i)), ChannelID: chID, SenderID: aliceID,
			SenderDevice: devA, Suite: "s.v1", Kind: "text", Body: []byte{byte(i)}}
		if err := st.InsertMessage(ctx, m, map[string][]byte{devB: {byte(i)}}); err != nil {
			t.Fatal(err)
		}
	}
	page1, _ := st.History(ctx, chID, devB, 0, 10)
	if len(page1) != 10 || page1[9].Seq != 25 || page1[0].Seq != 16 {
		t.Fatalf("newest page wrong: %d..%d", page1[0].Seq, page1[len(page1)-1].Seq)
	}
	page2, _ := st.History(ctx, chID, devB, page1[0].Seq, 10)
	if len(page2) != 10 || page2[9].Seq != 15 || page2[0].Seq != 6 {
		t.Fatalf("second page wrong: %d..%d", page2[0].Seq, page2[len(page2)-1].Seq)
	}
	page3, _ := st.History(ctx, chID, devB, page2[0].Seq, 10)
	if len(page3) != 5 {
		t.Fatalf("last page should have 5, got %d", len(page3))
	}
}

func TestDirectChannelIsFoundBothWays(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	aliceID, bobID, chID, _, _ := seed(t, st)

	for _, pair := range [][2]string{{aliceID, bobID}, {bobID, aliceID}} {
		c, err := st.DirectChannelBetween(ctx, pair[0], pair[1])
		if err != nil || c.ID != chID {
			t.Fatalf("DirectChannelBetween(%s,%s) = %v, %v", pair[0], pair[1], c, err)
		}
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Общее":            "общее",
		"Product   Team!!": "product-team",
		"  --hello--  ":    "hello",
		"###":              "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConcurrentSendsGetUniqueSequences(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	aliceID, _, chID, devA, devB := seed(t, st)

	const n = 50
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			m := &Message{ID: "cm" + string(rune(i)), ChannelID: chID, SenderID: aliceID,
				SenderDevice: devA, Suite: "s.v1", Kind: "text", Body: []byte{byte(i)}}
			done <- st.InsertMessage(ctx, m, map[string][]byte{devB: {1}})
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	msgs, _ := st.History(ctx, chID, devB, 0, 200)
	if len(msgs) != n {
		t.Fatalf("want %d messages, got %d", n, len(msgs))
	}
	seen := map[int64]bool{}
	for _, m := range msgs {
		if seen[m.Seq] {
			t.Fatalf("duplicate sequence %d", m.Seq)
		}
		seen[m.Seq] = true
	}
}

// A message sent a minute ago belongs in today's column, not yesterday's.
//
// The first implementation bucketed by "now minus N days", which is not a
// midnight, so anything recent fell one column short and the chart disagreed
// with its own day labels. This pins the calendar-day behaviour.
func TestPerDaySeriesUsesCalendarDays(t *testing.T) {
	st := openTmp(t, t.TempDir())
	defer st.Close()
	ctx := context.Background()
	aliceID, _, chID, devA, devB := seed(t, st)

	m := &Message{ID: "m_now", ChannelID: chID, SenderID: aliceID, SenderDevice: devA,
		Suite: "s.v1", Kind: "text", Body: []byte("ciphertext")}
	if err := st.InsertMessage(ctx, m, map[string][]byte{devB: []byte("k")}); err != nil {
		t.Fatal(err)
	}

	const days = 7
	now := time.Now()

	if got := st.MessagesPerDay(days, now.UnixMilli()); got[days-1] != 1 {
		t.Fatalf("message sent now landed in %v, want 1 in the last column", got)
	}
	if got := st.RegistrationsPerDay(days, now.UnixMilli()); got[days-1] != 2 {
		t.Fatalf("users created now landed in %v, want 2 in the last column", got)
	}

	// Late in the day must behave the same: this is the case the old rolling
	// window got wrong most often.
	endOfDay := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 0, 0, now.Location())
	if got := st.MessagesPerDay(days, endOfDay.UnixMilli()); got[days-1] != 1 {
		t.Fatalf("at 23:59 the message landed in %v, want 1 in the last column", got)
	}

	// And the series must always sum to what actually happened in the window.
	total := 0
	for _, n := range st.MessagesPerDay(days, now.UnixMilli()) {
		total += n
	}
	if total != 1 {
		t.Fatalf("series sums to %d, want 1", total)
	}
}
