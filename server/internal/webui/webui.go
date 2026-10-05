// Package webui embeds the built web client into the server binary, so a
// deployment is one file: no nginx, no separate static host, no CORS to
// configure. Serving it is optional (KIVORA_SERVE_WEB=false).
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// `make build` copies web/dist here first; the placeholder index.html keeps
// `go build` working in a fresh checkout where the client is not built yet.
//
//go:embed all:dist
var files embed.FS

// looksContentHashed reports whether a built asset carries a content hash in
// its name, e.g. "main-B7fK2xQ1.js".
//
// This matters more than it looks. "Cache for a year, immutable" is only safe
// when a changed file also changes its name; promise it for a stable name like
// "main.js" and every browser that visited the old version keeps running it
// after an upgrade — the operator redeploys, nothing changes, and the bug
// report says "it did not update". The builders here emit hashed names, but
// the header is derived from the actual filename rather than from trusting
// them, so a hand-assembled bundle degrades to a revalidated cache instead of
// a permanently wrong one.
func looksContentHashed(name string) bool {
	base := path.Base(name)
	ext := path.Ext(base)
	if ext == "" {
		return false
	}
	stem := strings.TrimSuffix(base, ext)
	dash := strings.LastIndexByte(stem, '-')
	if dash < 0 {
		return false
	}
	hash := stem[dash+1:]
	if len(hash) < 8 {
		return false
	}
	for i := 0; i < len(hash); i++ {
		c := hash[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c == '_':
		default:
			return false
		}
	}
	return true
}

// clientRoutes mirrors parseRoute() in web/src/lib/session.ts.
//
// Duplicating a router is unpleasant, but the alternative is worse: the server
// has to answer before any JavaScript runs, so it cannot ask the client what
// its routes are. Keeping the list here — short, in one place, and pinned by a
// test — is the cheapest honest version. Adding a client route means adding it
// here too, and the test says so out loud.
var clientRoutes = map[string]bool{
	"":               true, // "/"
	".":              true,
	"index.html":     true,
	"admin":          true,
	"admin/overview": true,
	"admin/users":    true,
	"admin/channels": true,
	"admin/security": true,
	"admin/pages":    true,
}

func isClientRoute(clean string) bool {
	return clientRoutes[clean]
}

// Handler serves the static bundle and falls back to index.html so client-side
// routes survive a refresh. Content-hashed assets get an immutable cache; the
// entry document and anything unhashed never do.
func Handler() http.Handler {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		return http.NotFoundHandler()
	}
	srv := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" || clean == "." {
			clean = "index.html"
		}
		if f, err := sub.Open(clean); err == nil {
			_ = f.Close()
			switch {
			case strings.HasPrefix(clean, "assets/") && looksContentHashed(clean):
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			case strings.HasPrefix(clean, "brand/"):
				// Logos change rarely and are not hashed; an hour is a fair
				// trade between a fresh icon and a request per page load.
				w.Header().Set("Cache-Control", "public, max-age=3600")
			default:
				w.Header().Set("Cache-Control", "no-cache")
			}
			srv.ServeHTTP(w, r)
			return
		}
		// A path with no file behind it is either one of the client's own
		// routes or a dead link, and the status code has to tell them apart.
		// A blanket 200 hides broken links from every crawler and monitor; a
		// blanket 404 marks the real admin console as missing.
		status := http.StatusNotFound
		if isClientRoute(clean) {
			status = http.StatusOK
		}
		w.Header().Set("Cache-Control", "no-cache")
		index, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(index)
	})
}
