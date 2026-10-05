// Package config loads the server configuration from a TOML-ish env-first
// source. Zero external dependencies: every value has a sane default so the
// server starts with no configuration at all ("./kivorad" just works), and
// every value can be overridden by an environment variable or a flag.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Network
	Addr        string
	PublicURL   string
	TrustProxy  bool
	CORSOrigins []string

	// Storage
	DataDir      string
	Sync         string // always | interval | never
	SyncInterval time.Duration
	CompactRatio float64

	// Security
	SecretKey        []byte // server secret, used for token hashing pepper
	RegistrationMode string // "open" | "invite" | "closed"
	InviteCodes      []string
	SessionTTL       time.Duration
	MaxUploadBytes   int64
	MaxFileBytes     int64
	MaxAvatarBytes   int64
	RetentionDays    int
	Argon2Memory     uint32
	Argon2Time       uint32
	Argon2Threads    uint8

	// Crypto policy: which client cipher suites the server accepts.
	// "*" means "anything the clients agree on" (the server never decrypts).
	AllowedSuites []string
	RequireE2E    bool

	// Limits (core protection)
	RateLimitRPS   float64
	RateLimitBurst int
	MaxMessageSize int
	MaxDevices     int

	// Calls. Kivora relays signalling only; the media path is negotiated by
	// the clients. A STUN server is enough on most networks, a TURN relay is
	// needed when both sides sit behind symmetric NAT.
	StunURLs []string
	TurnURL  string
	TurnUser string
	TurnPass string
}

func envStr(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, ok := os.LookupEnv(k); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	if v, ok := os.LookupEnv(k); ok {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return def
}

func envList(k string, def []string) []string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		parts := strings.Split(v, ",")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	return def
}

// Load builds the configuration. dataDir is created if missing, and a
// persistent server secret is generated on first run.
func Load() (*Config, error) {
	dataDir := envStr("KIVORA_DATA_DIR", "./data")
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}

	secret, err := loadOrCreateSecret(filepath.Join(abs, "secret.key"))
	if err != nil {
		return nil, err
	}

	c := &Config{
		Addr:       envStr("KIVORA_ADDR", ":8080"),
		PublicURL:  envStr("KIVORA_PUBLIC_URL", ""),
		TrustProxy: envBool("KIVORA_TRUST_PROXY", false),
		CORSOrigins: envList("KIVORA_CORS_ORIGINS", []string{
			"http://localhost:5173", "http://127.0.0.1:5173", "tauri://localhost",
			"http://tauri.localhost", "https://tauri.localhost",
		}),

		DataDir:      abs,
		Sync:         envStr("KIVORA_SYNC", "always"),
		SyncInterval: time.Duration(envInt("KIVORA_SYNC_INTERVAL_MS", 200)) * time.Millisecond,
		CompactRatio: float64(envInt("KIVORA_COMPACT_PERCENT", 30)) / 100,

		SecretKey:        secret,
		RegistrationMode: envStr("KIVORA_REGISTRATION", "open"),
		InviteCodes:      envList("KIVORA_INVITE_CODES", nil),
		SessionTTL:       time.Duration(envInt("KIVORA_SESSION_TTL_HOURS", 24*30)) * time.Hour,
		MaxUploadBytes:   int64(envInt("KIVORA_MAX_UPLOAD_MB", 64)) << 20,
		MaxFileBytes:     int64(envInt("KIVORA_MAX_FILE_MB", 32)) << 20,
		MaxAvatarBytes:   int64(envInt("KIVORA_MAX_AVATAR_KB", 2048)) << 10,
		Argon2Memory:     uint32(envInt("KIVORA_ARGON2_MEMORY_KIB", 64*1024)),
		Argon2Time:       uint32(envInt("KIVORA_ARGON2_TIME", 3)),
		Argon2Threads:    uint8(envInt("KIVORA_ARGON2_THREADS", 2)),

		AllowedSuites: envList("KIVORA_ALLOWED_SUITES", []string{"*"}),
		RequireE2E:    envBool("KIVORA_REQUIRE_E2E", false),

		RateLimitRPS:   float64(envInt("KIVORA_RATE_RPS", 25)),
		RateLimitBurst: envInt("KIVORA_RATE_BURST", 60),
		MaxMessageSize: envInt("KIVORA_MAX_MESSAGE_BYTES", 128*1024),
		MaxDevices:     envInt("KIVORA_MAX_DEVICES", 10),

		// 0 keeps history forever. Setting it is the cheapest privacy measure
		// an operator has: a message that no longer exists cannot be seized,
		// subpoenaed or leaked, and no amount of encryption achieves that.
		RetentionDays: envInt("KIVORA_RETENTION_DAYS", 0),

		StunURLs: envList("KIVORA_STUN_URLS", []string{"stun:stun.l.google.com:19302"}),
		TurnURL:  envStr("KIVORA_TURN_URL", ""),
		TurnUser: envStr("KIVORA_TURN_USER", ""),
		TurnPass: envStr("KIVORA_TURN_PASS", ""),
	}

	// The request-body cap has to be able to carry the largest file, or an
	// upload would be rejected by the wrong layer with the wrong message.
	if c.MaxUploadBytes < c.MaxFileBytes+(1<<20) {
		c.MaxUploadBytes = c.MaxFileBytes + (1 << 20)
	}

	switch c.Sync {
	case "always", "interval", "never":
	default:
		return nil, errors.New("KIVORA_SYNC must be one of: always, interval, never")
	}
	switch c.RegistrationMode {
	case "open", "invite", "closed":
	default:
		return nil, errors.New("KIVORA_REGISTRATION must be one of: open, invite, closed")
	}
	if c.RegistrationMode == "invite" && len(c.InviteCodes) == 0 {
		return nil, errors.New("registration mode is 'invite' but KIVORA_INVITE_CODES is empty")
	}
	return c, nil
}

func loadOrCreateSecret(path string) ([]byte, error) {
	if b, err := os.ReadFile(path); err == nil {
		s, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err == nil && len(s) == 32 {
			return s, nil
		}
	}
	s := make([]byte, 32)
	if _, err := rand.Read(s); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(s)), 0o600); err != nil {
		return nil, err
	}
	return s, nil
}

// SuiteAllowed reports whether a client-declared cipher suite id may be used.
func (c *Config) SuiteAllowed(id string) bool {
	for _, s := range c.AllowedSuites {
		if s == "*" || s == id {
			return true
		}
	}
	return false
}
