package store

// The storage engine.
//
// Kivora stores its state in two append-only files inside the data directory:
//
//	meta.log   framed JSON records — every state change, in order
//	blobs.dat  raw bytes — ciphertexts and wrapped-key maps, never parsed on write
//
// On start the log is replayed into memory; from then on reads are served from
// memory (blobs are read from disk on demand) and writes are one append plus an
// optional fsync. That is the whole design. It is a deliberate trade:
//
//   - it removes the last third-party dependency from the server,
//   - it makes the binary start on any machine with a writable directory,
//   - it costs memory proportional to metadata, not to message volume, and
//   - it gives up ad-hoc SQL queries, which a messenger does not need.
//
// Every record is checksummed. A crash mid-append leaves a short or corrupt
// tail; replay stops at the first bad record and truncates the file there, so a
// half-written message is simply the message that never arrived.

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type recordType string

const (
	recUser        recordType = "user"
	recUserUpdate  recordType = "user.update"
	recUserSeen    recordType = "user.seen"
	recUserFlags   recordType = "user.flags"
	recDevice      recordType = "device"
	recDeviceRevk  recordType = "device.revoke"
	recPreKeyAdd   recordType = "prekey.add"
	recPreKeyUse   recordType = "prekey.use"
	recSession     recordType = "session"
	recSessionDel  recordType = "session.del"
	recSessionBind recordType = "session.bind"
	recChannel     recordType = "channel"
	recChannelMeta recordType = "channel.meta"
	recChannelTTL  recordType = "channel.ttl"
	recMemberAdd   recordType = "member.add"
	recMemberDel   recordType = "member.del"
	recMemberRead  recordType = "member.read"
	recMessage     recordType = "msg"
	recMsgKeys     recordType = "msg.keys"
	recMsgDelete   recordType = "msg.del"
	recMsgEdit     recordType = "msg.edit"
	recMsgPin      recordType = "msg.pin"
	recMemberFlags recordType = "member.flags"
	recUpload      recordType = "upload"
	recUploadDel   recordType = "upload.del"
)

type record struct {
	T recordType      `json:"t"`
	D json.RawMessage `json:"d,omitempty"`
}

// blobRef points at a stretch of blobs.dat.
type blobRef struct {
	Off int64 `json:"o"`
	Len int32 `json:"l"`
}

func (b blobRef) empty() bool { return b.Len == 0 }

// SyncMode controls how hard the engine works to survive a power cut.
type SyncMode string

const (
	// SyncAlways fsyncs after every mutation. Safest, and on an SSD still
	// good for a few thousand messages per second.
	SyncAlways SyncMode = "always"
	// SyncInterval fsyncs at most once per interval. A crash can lose the
	// last few hundred milliseconds of traffic.
	SyncInterval SyncMode = "interval"
	// SyncNever leaves it to the operating system. For throwaway instances.
	SyncNever SyncMode = "never"
)

type wal struct {
	mu sync.Mutex

	dir      string
	metaPath string
	blobPath string

	meta *os.File
	blob *os.File

	blobEnd  int64
	syncMode SyncMode
	interval time.Duration
	dirty    bool
	lastSync time.Time
	stop     chan struct{}

	// bytesWritten counts appends since the last compaction, used to decide
	// when rewriting the log is worth it.
	bytesWritten int64
	liveBytes    int64
}

func openWAL(dir string, mode SyncMode, interval time.Duration) (*wal, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	w := &wal{
		dir:      dir,
		metaPath: filepath.Join(dir, "meta.log"),
		blobPath: filepath.Join(dir, "blobs.dat"),
		syncMode: mode,
		interval: interval,
		stop:     make(chan struct{}),
	}
	var err error
	if w.blob, err = os.OpenFile(w.blobPath, os.O_RDWR|os.O_CREATE, 0o600); err != nil {
		return nil, err
	}
	if w.blobEnd, err = w.blob.Seek(0, io.SeekEnd); err != nil {
		return nil, err
	}
	if mode == SyncInterval {
		go w.syncLoop()
	}
	return w, nil
}

// replay reads the whole meta log, handing each record to apply. A truncated or
// corrupt tail is cut off rather than refused: refusing to start because the
// last write was interrupted would be the wrong failure mode for a server.
func (w *wal) replay(apply func(recordType, json.RawMessage) error) error {
	f, err := os.OpenFile(w.metaPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	r := bufio.NewReaderSize(f, 1<<16)
	var offset int64
	head := make([]byte, 8)

	for {
		if _, err := io.ReadFull(r, head); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			break // short header: truncated tail
		}
		length := binary.LittleEndian.Uint32(head[:4])
		want := binary.LittleEndian.Uint32(head[4:])
		if length == 0 || length > 64<<20 {
			break
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(r, payload); err != nil {
			break
		}
		if crc32.ChecksumIEEE(payload) != want {
			break
		}
		var rec record
		if err := json.Unmarshal(payload, &rec); err != nil {
			break
		}
		if err := apply(rec.T, rec.D); err != nil {
			return fmt.Errorf("replay %s: %w", rec.T, err)
		}
		offset += 8 + int64(length)
	}

	// Cut the bad tail so the next append starts from a consistent point.
	if size, err := f.Seek(0, io.SeekEnd); err == nil && size != offset {
		if err := f.Truncate(offset); err != nil {
			return err
		}
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	w.meta = f
	w.liveBytes = offset
	return nil
}

func (w *wal) append(t recordType, data any) error {
	payload, err := json.Marshal(record{T: t, D: mustRaw(data)})
	if err != nil {
		return err
	}
	head := make([]byte, 8)
	binary.LittleEndian.PutUint32(head[:4], uint32(len(payload)))
	binary.LittleEndian.PutUint32(head[4:], crc32.ChecksumIEEE(payload))

	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.meta.Write(head); err != nil {
		return err
	}
	if _, err := w.meta.Write(payload); err != nil {
		return err
	}
	w.bytesWritten += int64(len(payload)) + 8
	return w.maybeSyncLocked()
}

func (w *wal) maybeSyncLocked() error {
	switch w.syncMode {
	case SyncAlways:
		return w.meta.Sync()
	case SyncInterval:
		w.dirty = true
		return nil
	default:
		return nil
	}
}

func (w *wal) syncLoop() {
	t := time.NewTicker(w.interval)
	defer t.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
			w.mu.Lock()
			if w.dirty {
				_ = w.meta.Sync()
				_ = w.blob.Sync()
				w.dirty = false
			}
			w.mu.Unlock()
		}
	}
}

// putBlob appends opaque bytes and returns their location. The engine never
// looks inside: for encrypted channels this is ciphertext the server could not
// read even if it wanted to.
func (w *wal) putBlob(b []byte) (blobRef, error) {
	if len(b) == 0 {
		return blobRef{}, nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	off := w.blobEnd
	if _, err := w.blob.WriteAt(b, off); err != nil {
		return blobRef{}, err
	}
	w.blobEnd += int64(len(b))
	if w.syncMode == SyncAlways {
		if err := w.blob.Sync(); err != nil {
			return blobRef{}, err
		}
	} else {
		w.dirty = true
	}
	return blobRef{Off: off, Len: int32(len(b))}, nil
}

func (w *wal) getBlob(ref blobRef) ([]byte, error) {
	if ref.empty() {
		return nil, nil
	}
	buf := make([]byte, ref.Len)
	if _, err := w.blob.ReadAt(buf, ref.Off); err != nil {
		return nil, err
	}
	return buf, nil
}

func (w *wal) close() error {
	select {
	case <-w.stop:
	default:
		close(w.stop)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	var first error
	for _, f := range []*os.File{w.meta, w.blob} {
		if f == nil {
			continue
		}
		if err := f.Sync(); err != nil && first == nil {
			first = err
		}
		if err := f.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// rewrite replaces both files with a compacted copy produced by emit. It writes
// to temporary files and renames them into place, so a crash during compaction
// leaves the previous, still-valid database untouched.
func (w *wal) rewrite(emit func(add func(recordType, any) error, put func([]byte) (blobRef, error)) error) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	metaTmp := w.metaPath + ".compact"
	blobTmp := w.blobPath + ".compact"
	mf, err := os.OpenFile(metaTmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	bf, err := os.OpenFile(blobTmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		mf.Close()
		return err
	}
	mw := bufio.NewWriterSize(mf, 1<<20)
	var newMeta, newBlobEnd int64

	add := func(t recordType, data any) error {
		payload, err := json.Marshal(record{T: t, D: mustRaw(data)})
		if err != nil {
			return err
		}
		head := make([]byte, 8)
		binary.LittleEndian.PutUint32(head[:4], uint32(len(payload)))
		binary.LittleEndian.PutUint32(head[4:], crc32.ChecksumIEEE(payload))
		if _, err := mw.Write(head); err != nil {
			return err
		}
		if _, err := mw.Write(payload); err != nil {
			return err
		}
		newMeta += int64(len(payload)) + 8
		return nil
	}
	put := func(b []byte) (blobRef, error) {
		if len(b) == 0 {
			return blobRef{}, nil
		}
		off := newBlobEnd
		if _, err := bf.WriteAt(b, off); err != nil {
			return blobRef{}, err
		}
		newBlobEnd += int64(len(b))
		return blobRef{Off: off, Len: int32(len(b))}, nil
	}

	if err := emit(add, put); err != nil {
		mf.Close()
		bf.Close()
		return err
	}
	if err := mw.Flush(); err != nil {
		return err
	}
	for _, f := range []*os.File{mf, bf} {
		if err := f.Sync(); err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	_ = w.meta.Close()
	_ = w.blob.Close()
	if err := os.Rename(metaTmp, w.metaPath); err != nil {
		return err
	}
	if err := os.Rename(blobTmp, w.blobPath); err != nil {
		return err
	}
	if w.meta, err = os.OpenFile(w.metaPath, os.O_RDWR|os.O_APPEND, 0o600); err != nil {
		return err
	}
	if w.blob, err = os.OpenFile(w.blobPath, os.O_RDWR, 0o600); err != nil {
		return err
	}
	w.blobEnd = newBlobEnd
	w.liveBytes = newMeta
	w.bytesWritten = 0
	return syncDir(w.dir)
}

// syncDir fsyncs the directory so the renames above survive a power cut too.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func mustRaw(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}
