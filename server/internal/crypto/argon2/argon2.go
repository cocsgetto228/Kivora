// Package argon2 implements Argon2id (RFC 9106), the password-hashing function
// that won the Password Hashing Competition and is what OWASP recommends today.
//
// Why it is here instead of a module: the server takes no third-party
// dependencies, and password hashing is the one place where "just pull in a
// library" is least attractive — it is the code that decides how expensive a
// stolen database is to crack. The implementation is validated against the test
// vector printed in RFC 9106 §5.3; see argon2_test.go.
//
// Argon2id is the hybrid mode: the first half-pass resists side-channel
// attacks like Argon2i, the rest resists GPU cracking like Argon2d.
package argon2

import (
	"encoding/binary"
	"math/bits"
	"sync"

	"github.com/kivora-im/kivora/server/internal/crypto/blake2b"
)

const (
	Version    = 0x13
	blockSize  = 1024          // bytes
	words      = blockSize / 8 // uint64s per block
	syncPoints = 4
)

type block [words]uint64

// IDKey derives a key with Argon2id. memory is in KiB, time is the number of
// passes, threads is the degree of parallelism.
func IDKey(password, salt []byte, time, memory uint32, threads uint8, keyLen uint32) []byte {
	return Key(password, salt, nil, nil, time, memory, threads, keyLen)
}

// Key is the full interface, including the optional secret ("pepper") and
// associated data from the specification. A secret held outside the database
// means a database leak alone is not enough to start cracking.
func Key(password, salt, secret, data []byte, time, memory uint32, threads uint8, keyLen uint32) []byte {
	if time < 1 {
		time = 1
	}
	if threads < 1 {
		threads = 1
	}
	lanes := uint32(threads)

	h0 := initialHash(password, salt, secret, data, time, memory, lanes, keyLen)

	// Round the memory down to a multiple of 4*lanes, as the spec requires.
	memoryBlocks := memory
	if memoryBlocks < 8*lanes {
		memoryBlocks = 8 * lanes
	}
	memoryBlocks = (memoryBlocks / (syncPoints * lanes)) * (syncPoints * lanes)
	laneLength := memoryBlocks / lanes
	segmentLength := laneLength / syncPoints

	B := make([]block, memoryBlocks)
	initBlocks(B, h0, lanes, laneLength)
	processBlocks(B, time, memoryBlocks, lanes, laneLength, segmentLength)

	// The final block is the XOR of the last block of every lane.
	var final block
	for l := uint32(0); l < lanes; l++ {
		last := B[l*laneLength+laneLength-1]
		for i := range final {
			final[i] ^= last[i]
		}
	}
	var buf [blockSize]byte
	blockToBytes(&final, buf[:])
	return hashPrime(buf[:], keyLen)
}

func initialHash(password, salt, secret, data []byte, time, memory, lanes, keyLen uint32) []byte {
	h, _ := blake2b.New(64, nil)
	var u32 [4]byte
	put := func(v uint32) {
		binary.LittleEndian.PutUint32(u32[:], v)
		h.Write(u32[:])
	}
	putBytes := func(b []byte) {
		put(uint32(len(b)))
		h.Write(b)
	}
	put(lanes)
	put(keyLen)
	put(memory)
	put(time)
	put(Version)
	put(2) // Argon2id
	putBytes(password)
	putBytes(salt)
	putBytes(secret)
	putBytes(data)
	return h.Sum(nil)
}

// hashPrime is the specification's H' — BLAKE2b extended to arbitrary output
// length by chaining 64-byte digests and taking 32 bytes from each.
func hashPrime(input []byte, outLen uint32) []byte {
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], outLen)

	if outLen <= 64 {
		h, _ := blake2b.New(int(outLen), nil)
		h.Write(lenBuf[:])
		h.Write(input)
		return h.Sum(nil)
	}

	out := make([]byte, 0, outLen)
	h, _ := blake2b.New(64, nil)
	h.Write(lenBuf[:])
	h.Write(input)
	v := h.Sum(nil)
	out = append(out, v[:32]...)

	r := (outLen+31)/32 - 2
	for i := uint32(1); i < r; i++ {
		h, _ = blake2b.New(64, nil)
		h.Write(v)
		v = h.Sum(nil)
		out = append(out, v[:32]...)
	}
	h, _ = blake2b.New(int(outLen-32*r), nil)
	h.Write(v)
	return append(out, h.Sum(nil)...)
}

func initBlocks(B []block, h0 []byte, lanes, laneLength uint32) {
	var buf [72]byte
	copy(buf[:64], h0)
	for l := uint32(0); l < lanes; l++ {
		binary.LittleEndian.PutUint32(buf[64:], 0)
		binary.LittleEndian.PutUint32(buf[68:], l)
		bytesToBlock(hashPrime(buf[:], blockSize), &B[l*laneLength])

		binary.LittleEndian.PutUint32(buf[64:], 1)
		bytesToBlock(hashPrime(buf[:], blockSize), &B[l*laneLength+1])
	}
}

func processBlocks(B []block, time, memoryBlocks, lanes, laneLength, segmentLength uint32) {
	var wg sync.WaitGroup
	for pass := uint32(0); pass < time; pass++ {
		for slice := uint32(0); slice < syncPoints; slice++ {
			// Lanes within a slice are independent — this is the
			// parallelism Argon2 was designed around.
			wg.Add(int(lanes))
			for lane := uint32(0); lane < lanes; lane++ {
				go func(pass, slice, lane uint32) {
					defer wg.Done()
					fillSegment(B, pass, slice, lane, time, memoryBlocks, lanes, laneLength, segmentLength)
				}(pass, slice, lane)
			}
			wg.Wait()
		}
	}
}

func fillSegment(B []block, pass, slice, lane, time, memoryBlocks, lanes, laneLength, segmentLength uint32) {
	// Argon2id: the first two slices of the first pass use data-independent
	// addressing, everything after that is data-dependent.
	dataIndependent := pass == 0 && slice < 2

	var addresses, input, zero block
	if dataIndependent {
		input[0] = uint64(pass)
		input[1] = uint64(lane)
		input[2] = uint64(slice)
		input[3] = uint64(memoryBlocks)
		input[4] = uint64(time)
		input[5] = 2 // Argon2id
	}

	start := uint32(0)
	if pass == 0 && slice == 0 {
		start = 2 // the first two blocks of each lane are the seeds
		if dataIndependent {
			input[6]++
			fillAddressBlock(&addresses, &input, &zero)
		}
	}

	offset := lane*laneLength + slice*segmentLength + start
	var prev block
	if offset%laneLength == 0 {
		prev = B[offset+laneLength-1] // wrap to the end of the lane
	} else {
		prev = B[offset-1]
	}

	for index := start; index < segmentLength; index, offset = index+1, offset+1 {
		if offset%laneLength == 1 {
			prev = B[offset-1]
		}

		var rand uint64
		if dataIndependent {
			if index%words == 0 {
				input[6]++
				fillAddressBlock(&addresses, &input, &zero)
			}
			rand = addresses[index%words]
		} else {
			rand = prev[0]
		}

		refLane := uint32(rand>>32) % lanes
		if pass == 0 && slice == 0 {
			refLane = lane
		}
		refIndex := indexAlpha(rand, pass, slice, index, refLane == lane, laneLength, segmentLength)

		ref := &B[refLane*laneLength+refIndex]
		cur := &B[offset]
		if pass == 0 {
			fillBlock(&prev, ref, cur, false)
		} else {
			fillBlock(&prev, ref, cur, true)
		}
		prev = *cur
	}
}

// indexAlpha maps a pseudo-random value onto the window of blocks that may be
// referenced from the current position. The quadratic mapping is what biases
// references toward recently computed blocks.
func indexAlpha(rand uint64, pass, slice, index uint32, sameLane bool, laneLength, segmentLength uint32) uint32 {
	var refAreaSize uint32
	if pass == 0 {
		if slice == 0 {
			refAreaSize = index - 1
		} else if sameLane {
			refAreaSize = slice*segmentLength + index - 1
		} else {
			refAreaSize = slice * segmentLength
			if index == 0 {
				refAreaSize--
			}
		}
	} else {
		if sameLane {
			refAreaSize = laneLength - segmentLength + index - 1
		} else {
			refAreaSize = laneLength - segmentLength
			if index == 0 {
				refAreaSize--
			}
		}
	}

	phi := rand & 0xFFFFFFFF
	relative := (phi * phi) >> 32
	relative = uint64(refAreaSize) - 1 - (uint64(refAreaSize)*relative)>>32

	startPos := uint32(0)
	if pass != 0 && slice != syncPoints-1 {
		startPos = (slice + 1) * segmentLength
	}
	return (startPos + uint32(relative)) % laneLength
}

func fillAddressBlock(addresses, input, zero *block) {
	var tmp block
	fillBlock(zero, input, &tmp, false)
	fillBlock(zero, &tmp, addresses, false)
}

// fillBlock is Argon2's compression function G. xorWith controls the difference
// between the first pass (overwrite) and later passes (XOR into the old block).
func fillBlock(prev, ref, out *block, xorWith bool) {
	var r, q, z block
	for i := range r {
		r[i] = prev[i] ^ ref[i]
	}
	q = r

	// Round 1: over the eight rows.
	for i := 0; i < 8; i++ {
		p := q[i*16 : i*16+16]
		permute(
			&p[0], &p[1], &p[2], &p[3], &p[4], &p[5], &p[6], &p[7],
			&p[8], &p[9], &p[10], &p[11], &p[12], &p[13], &p[14], &p[15])
	}
	// Round 2: over the eight columns.
	for i := 0; i < 8; i++ {
		permute(
			&q[2*i], &q[2*i+1], &q[2*i+16], &q[2*i+17],
			&q[2*i+32], &q[2*i+33], &q[2*i+48], &q[2*i+49],
			&q[2*i+64], &q[2*i+65], &q[2*i+80], &q[2*i+81],
			&q[2*i+96], &q[2*i+97], &q[2*i+112], &q[2*i+113])
	}
	for i := range z {
		z[i] = q[i] ^ r[i]
	}
	if xorWith {
		for i := range out {
			out[i] ^= z[i]
		}
	} else {
		*out = z
	}
}

func permute(v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15 *uint64) {
	blamka(v0, v4, v8, v12)
	blamka(v1, v5, v9, v13)
	blamka(v2, v6, v10, v14)
	blamka(v3, v7, v11, v15)
	blamka(v0, v5, v10, v15)
	blamka(v1, v6, v11, v12)
	blamka(v2, v7, v8, v13)
	blamka(v3, v4, v9, v14)
}

// blamka is BLAKE2b's G with the extra 64-bit multiplication that makes
// Argon2's compression expensive to implement in cheap hardware.
func blamka(a, b, c, d *uint64) {
	*a = mulAdd(*a, *b)
	*d = bits.RotateLeft64(*d^*a, -32)
	*c = mulAdd(*c, *d)
	*b = bits.RotateLeft64(*b^*c, -24)
	*a = mulAdd(*a, *b)
	*d = bits.RotateLeft64(*d^*a, -16)
	*c = mulAdd(*c, *d)
	*b = bits.RotateLeft64(*b^*c, -63)
}

func mulAdd(x, y uint64) uint64 {
	return x + y + 2*(x&0xFFFFFFFF)*(y&0xFFFFFFFF)
}

func bytesToBlock(b []byte, out *block) {
	for i := range out {
		out[i] = binary.LittleEndian.Uint64(b[i*8:])
	}
}

func blockToBytes(in *block, b []byte) {
	for i, v := range in {
		binary.LittleEndian.PutUint64(b[i*8:], v)
	}
}
