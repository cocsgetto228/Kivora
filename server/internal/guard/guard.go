// Package guard holds the server half of "core protection": the middleware
// that stands between the open internet and the message core. None of it is
// exotic — it is the boring layer that actually stops the common attacks.
package guard

import (
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------- rate limit

type bucket struct {
	tokens float64
	last   time.Time
}

// Limiter is a per-IP token bucket. It is intentionally in-process and
// allocation-light: no Redis, no goroutine per client, so it costs nothing on
// a 1-core VPS.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rps     float64
	burst   float64
}

func NewLimiter(rps float64, burst int) *Limiter {
	l := &Limiter{buckets: make(map[string]*bucket), rps: rps, burst: float64(burst)}
	go l.janitor()
	return l
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rps
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *Limiter) janitor() {
	for range time.Tick(5 * time.Minute) {
		cutoff := time.Now().Add(-10 * time.Minute)
		l.mu.Lock()
		for k, b := range l.buckets {
			if b.last.Before(cutoff) {
				delete(l.buckets, k)
			}
		}
		l.mu.Unlock()
	}
}

func (l *Limiter) Middleware(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.Allow(ClientIP(r, trustProxy)) {
				w.Header().Set("Retry-After", "2")
				http.Error(w, `{"error":"rate_limited"}`, http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// ClientIP only believes X-Forwarded-For when the operator says there is a
// trusted proxy in front. Otherwise a header is enough to defeat rate limiting.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---------------------------------------------------------------- headers

// SecurityHeaders sets a content security policy tight enough that an injected
// script has nowhere to send stolen keys. 'unsafe-inline' is absent on purpose:
// the web client ships no inline scripts.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		// camera and microphone are allowed for this origin only ("self"),
		// because calls need them. Denying them outright — which this header
		// used to do — silently broke every call in the browser: getUserMedia
		// rejects with a permissions-policy violation before the user is even
		// asked. Everything the app has no business touching stays denied.
		h.Set("Permissions-Policy",
			"geolocation=(), camera=(self), microphone=(self), display-capture=(self), payment=(), usb=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Content-Security-Policy", strings.Join([]string{
				"default-src 'self'",
				"script-src 'self' 'wasm-unsafe-eval'",
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob:",
				"media-src 'self' blob:",
				"font-src 'self' data:",
				"connect-src 'self' ws: wss:",
				"object-src 'none'",
				"base-uri 'none'",
				"form-action 'self'",
				"frame-ancestors 'none'",
			}, "; "))
		}
		next.ServeHTTP(w, r)
	})
}

// MaxBody rejects oversized requests before they are read into memory.
func MaxBody(limit int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
			next.ServeHTTP(w, r)
		})
	}
}

// Recover keeps one bad request from taking the process down, and never leaks
// the stack trace to the client.
func Recover(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if v := recover(); v != nil {
					log.Error("panic", "path", r.URL.Path, "value", v)
					http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// CORS allows exactly the origins the operator listed. Credentials are never
// sent via cookies (the client uses an Authorization header), so a stolen
// origin cannot ride along on an existing session.
func CORS(origins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[strings.TrimRight(o, "/")] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimRight(r.Header.Get("Origin"), "/")
			if origin != "" && (allowed[origin] || allowed["*"]) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Kivora-Device")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				h.Set("Access-Control-Max-Age", "600")
				h.Add("Vary", "Origin")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Chain applies middleware in the order given, outermost first.
func Chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mw) - 1; i >= 0; i-- {
		h = mw[i](h)
	}
	return h
}
