// Package blake2b implements BLAKE2b (RFC 7693).
//
// It lives in this repository rather than coming from a module because the
// server has a no-third-party-dependencies rule (see go.mod), and because
// Argon2 needs BLAKE2b's variable-length output, which the standard library
// does not provide. The implementation is checked against the RFC's own test
// vectors in blake2b_test.go — if those pass, this file is doing exactly what
// the specification says.
package blake2b

import (
	"encoding/binary"
	"errors"
	"hash"
	"math/bits"
)

const (
	BlockSize = 128
	Size      = 64
)

var iv = [8]uint64{
	0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
	0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
}

var sigma = [12][16]byte{
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
	{11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
	{7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
	{9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
	{2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
	{12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
	{13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
	{6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
	{10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
	{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
	{14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
}

type digest struct {
	h      [8]uint64
	t      [2]uint64
	buf    [BlockSize]byte
	buflen int
	size   int
	key    [BlockSize]byte
	keyLen int
}

// New returns a BLAKE2b hash producing size bytes, optionally keyed.
func New(size int, key []byte) (hash.Hash, error) {
	if size <= 0 || size > Size {
		return nil, errors.New("blake2b: invalid digest size")
	}
	if len(key) > Size {
		return nil, errors.New("blake2b: key too long")
	}
	d := &digest{size: size, keyLen: len(key)}
	copy(d.key[:], key)
	d.Reset()
	return d, nil
}

// Sum512 is the common case: an unkeyed 64-byte digest.
func Sum512(data []byte) [Size]byte {
	var out [Size]byte
	d, _ := New(Size, nil)
	d.Write(data)
	copy(out[:], d.Sum(nil))
	return out
}

// Sum returns an unkeyed digest of the requested length.
func Sum(size int, data []byte) []byte {
	d, err := New(size, nil)
	if err != nil {
		panic(err)
	}
	d.Write(data)
	return d.Sum(nil)
}

func (d *digest) Size() int      { return d.size }
func (d *digest) BlockSize() int { return BlockSize }

func (d *digest) Reset() {
	d.h = iv
	// Parameter block: digest length, key length, fanout 1, depth 1.
	d.h[0] ^= uint64(d.size) | uint64(d.keyLen)<<8 | 1<<16 | 1<<24
	d.t[0], d.t[1] = 0, 0
	d.buflen = 0
	if d.keyLen > 0 {
		// A keyed hash starts with the key padded to one full block.
		copy(d.buf[:], d.key[:])
		d.buflen = BlockSize
	}
}

func (d *digest) Write(p []byte) (int, error) {
	n := len(p)
	// Keep at least one byte buffered: the final block must be compressed
	// with the "last block" flag, and we only know it is last at Sum time.
	if d.buflen > 0 {
		free := BlockSize - d.buflen
		if len(p) > free {
			copy(d.buf[d.buflen:], p[:free])
			p = p[free:]
			d.buflen = 0
			d.compress(d.buf[:], false)
		} else {
			copy(d.buf[d.buflen:], p)
			d.buflen += len(p)
			return n, nil
		}
	}
	for len(p) > BlockSize {
		d.compress(p[:BlockSize], false)
		p = p[BlockSize:]
	}
	copy(d.buf[:], p)
	d.buflen = len(p)
	return n, nil
}

func (d *digest) Sum(b []byte) []byte {
	c := *d // Sum must not destroy the running state
	var block [BlockSize]byte
	copy(block[:], c.buf[:c.buflen])
	c.t[0] += uint64(c.buflen)
	if c.t[0] < uint64(c.buflen) {
		c.t[1]++
	}
	c.compressFinal(block[:])
	var out [Size]byte
	for i, v := range c.h {
		binary.LittleEndian.PutUint64(out[i*8:], v)
	}
	return append(b, out[:c.size]...)
}

func (d *digest) compress(block []byte, last bool) {
	d.t[0] += BlockSize
	if d.t[0] < BlockSize {
		d.t[1]++
	}
	d.mix(block, last)
}

func (d *digest) compressFinal(block []byte) { d.mix(block, true) }

func (d *digest) mix(block []byte, last bool) {
	var m [16]uint64
	for i := 0; i < 16; i++ {
		m[i] = binary.LittleEndian.Uint64(block[i*8:])
	}
	var v [16]uint64
	copy(v[:8], d.h[:])
	copy(v[8:], iv[:])
	v[12] ^= d.t[0]
	v[13] ^= d.t[1]
	if last {
		v[14] = ^v[14]
	}
	for r := 0; r < 12; r++ {
		s := &sigma[r]
		g(&v, 0, 4, 8, 12, m[s[0]], m[s[1]])
		g(&v, 1, 5, 9, 13, m[s[2]], m[s[3]])
		g(&v, 2, 6, 10, 14, m[s[4]], m[s[5]])
		g(&v, 3, 7, 11, 15, m[s[6]], m[s[7]])
		g(&v, 0, 5, 10, 15, m[s[8]], m[s[9]])
		g(&v, 1, 6, 11, 12, m[s[10]], m[s[11]])
		g(&v, 2, 7, 8, 13, m[s[12]], m[s[13]])
		g(&v, 3, 4, 9, 14, m[s[14]], m[s[15]])
	}
	for i := 0; i < 8; i++ {
		d.h[i] ^= v[i] ^ v[i+8]
	}
}

func g(v *[16]uint64, a, b, c, dd int, x, y uint64) {
	v[a] += v[b] + x
	v[dd] = bits.RotateLeft64(v[dd]^v[a], -32)
	v[c] += v[dd]
	v[b] = bits.RotateLeft64(v[b]^v[c], -24)
	v[a] += v[b] + y
	v[dd] = bits.RotateLeft64(v[dd]^v[a], -16)
	v[c] += v[dd]
	v[b] = bits.RotateLeft64(v[b]^v[c], -63)
}
