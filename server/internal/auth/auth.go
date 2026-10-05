// Package auth owns password hashing and session tokens.
//
// Two deliberate choices worth knowing about:
//
//  1. Passwords are hashed with Argon2id, the current PHC recommendation, with
//     parameters that live in the config so an operator on a small VPS can turn
//     them down and an operator on real hardware can turn them up.
//  2. Session tokens are opaque 32-byte random strings, never JWTs. Only their
//     HMAC (keyed with the server secret) is stored, so a database leak does not
//     hand out live sessions, and revocation is a DELETE rather than a
//     blocklist. The password never leaves the client unhashed either: the
//     client pre-hashes it, see docs/CRYPTO.md.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/kivora-im/kivora/server/internal/crypto/argon2"
)

var ErrInvalidHash = errors.New("invalid password hash format")

type Params struct {
	Memory  uint32
	Time    uint32
	Threads uint8
	KeyLen  uint32
	SaltLen uint32
}

func DefaultParams() Params {
	return Params{Memory: 64 * 1024, Time: 3, Threads: 2, KeyLen: 32, SaltLen: 16}
}

// HashPassword returns a PHC-format string: $argon2id$v=19$m=..,t=..,p=..$salt$hash
func HashPassword(password string, p Params) (string, error) {
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.Memory, p.Time, p.Threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// NewToken returns a fresh session token and the value to store for it.
func NewToken(serverSecret []byte) (token, hash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(serverSecret, token), nil
}

// HashToken is a keyed hash, not a bare SHA-256: an attacker with the database
// but not the server secret cannot even build a rainbow table of tokens.
func HashToken(serverSecret []byte, token string) string {
	mac := hmac.New(sha256.New, serverSecret)
	mac.Write([]byte(token))
	return hex.EncodeToString(mac.Sum(nil))
}

// NewID returns a sortable, URL-safe 128-bit identifier. Sortable ids keep
// database indexes tight compared to random UUIDs.
func NewID(prefix string) string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err) // a failing CSPRNG is not something to paper over
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	if prefix == "" {
		return id
	}
	return prefix + "_" + id
}

// ConstantTimeEqualString avoids leaking invite codes through timing.
func ConstantTimeEqualString(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
