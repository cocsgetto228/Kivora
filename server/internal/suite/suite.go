// Package suite is the server's view of the pluggable cipher system.
//
// The server never encrypts or decrypts message content — that is the whole
// point of end-to-end encryption. What it does own is *policy*: which suite
// identifiers are acceptable on this deployment, what the shape of a suite id
// is, and whether two devices can talk to each other at all.
//
// A suite id looks like:
//
//	vendor.primitive-chain.vN     e.g. kivora.x25519-xchacha20poly1305.v1
//
// Adding your own algorithm therefore means: implement it in the client
// (packages/kivora-crypto), give it an id, and either allow "*" here or add the
// id to KIVORA_ALLOWED_SUITES. The server needs no code change and no rebuild.
package suite

import (
	"errors"
	"regexp"
	"strings"
)

var idPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:[-+][a-z0-9]+)*\.v[0-9]+$`)

var (
	ErrMalformed  = errors.New("malformed cipher suite id")
	ErrNotAllowed = errors.New("cipher suite not allowed by server policy")
)

// Descriptor is metadata the server publishes so clients can negotiate without
// hardcoding anything.
type Descriptor struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	KEM         string `json:"kem"`
	AEAD        string `json:"aead"`
	KDF         string `json:"kdf"`
	Recommended bool   `json:"recommended"`
	Notes       string `json:"notes,omitempty"`
}

// Builtin describes the suites the reference client ships with. This list is
// advisory: the server accepts any well-formed id that policy allows, including
// ones it has never heard of.
func Builtin() []Descriptor {
	return []Descriptor{
		{
			ID: "kivora.x25519-xchacha20poly1305.v1", Label: "X25519 + XChaCha20-Poly1305",
			KEM: "X25519", AEAD: "XChaCha20-Poly1305", KDF: "HKDF-SHA256", Recommended: true,
			Notes: "Default. Fast in software on machines without AES-NI, 24-byte nonces make random nonces safe.",
		},
		{
			ID: "kivora.x25519-aes256gcm.v1", Label: "X25519 + AES-256-GCM",
			KEM: "X25519", AEAD: "AES-256-GCM", KDF: "HKDF-SHA256",
			Notes: "Hardware-accelerated on modern CPUs; uses the browser's native WebCrypto AES.",
		},
		{
			ID: "kivora.hybrid-x25519+mlkem768-xchacha20poly1305.v1", Label: "Hybrid X25519 + ML-KEM-768",
			KEM: "X25519 + ML-KEM-768", AEAD: "XChaCha20-Poly1305", KDF: "HKDF-SHA256",
			Notes: "Post-quantum hybrid. Larger keys and handshakes; enable when harvest-now-decrypt-later is in your threat model.",
		},
	}
}

// Validate checks an id against the grammar and the operator's allow-list.
func Validate(id string, allowed func(string) bool) error {
	if !idPattern.MatchString(id) {
		return ErrMalformed
	}
	if !allowed(id) {
		return ErrNotAllowed
	}
	return nil
}

// Version extracts the trailing version number, used to reject downgrades.
func Version(id string) int {
	i := strings.LastIndex(id, ".v")
	if i < 0 {
		return 0
	}
	n := 0
	for _, r := range id[i+2:] {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// Family is the id without its version, so v1 and v2 of the same construction
// can be recognised as related.
func Family(id string) string {
	if i := strings.LastIndex(id, ".v"); i > 0 {
		return id[:i]
	}
	return id
}

// Compatible reports whether a sender using `a` can address a device that
// advertises `b`. Same family and same version only: silently downgrading to an
// older version of a suite is how real protocols get broken.
func Compatible(a, b string) bool {
	return Family(a) == Family(b) && Version(a) == Version(b)
}
