// Command kivorad is the Kivora messenger server: one static binary that carries
// the API, the realtime hub, the database schema and the web client.
//
//	./kivorad                 # SQLite in ./data, listening on :8080
//	KIVORA_ADDR=:9000 ./kivorad
//
// Every knob is an environment variable; see docs/DEPLOY.md.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/kivora-im/kivora/server/internal/api"
	"github.com/kivora-im/kivora/server/internal/config"
	"github.com/kivora-im/kivora/server/internal/hub"
	"github.com/kivora-im/kivora/server/internal/store"
	"github.com/kivora-im/kivora/server/internal/webui"
)

func main() {
	var (
		showVersion = flag.Bool("version", false, "print version and exit")
		serveWeb    = flag.Bool("web", true, "serve the embedded web client")
		logLevel    = flag.String("log", "info", "log level: debug|info|warn|error")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("kivorad %s (protocol %d, %s/%s, %s)\n",
			api.Version, api.ProtocolVersion, runtime.GOOS, runtime.GOARCH, runtime.Version())
		return
	}

	log := newLogger(*logLevel)

	cfg, err := config.Load()
	if err != nil {
		log.Error("configuration", "err", err)
		os.Exit(1)
	}

	st, err := store.Open(store.Options{
		Dir:          cfg.DataDir,
		Sync:         store.SyncMode(cfg.Sync),
		SyncInterval: cfg.SyncInterval,
		CompactRatio: cfg.CompactRatio,
	})
	if err != nil {
		log.Error("database", "err", err)
		os.Exit(1)
	}
	defer st.Close()

	h := hub.New(log)

	var web http.Handler
	if *serveWeb && os.Getenv("KIVORA_SERVE_WEB") != "false" {
		web = webui.Handler()
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(cfg, st, h, log, web).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      0, // websockets live longer than any write timeout
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16,
	}

	go sweepSessions(st, log)
	go sweepExpiredMessages(st, h, cfg, log)

	go func() {
		log.Info("kivora listening",
			"addr", cfg.Addr, "data", cfg.DataDir, "sync", cfg.Sync,
			"registration", cfg.RegistrationMode, "version", api.Version,
			"state", st.Stats())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("shutdown", "err", err)
	}
}

func newLogger(level string) *slog.Logger {
	var l slog.Level
	if err := l.UnmarshalText([]byte(level)); err != nil {
		l = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

// sweepSessions keeps the sessions table from growing without bound. Expired
// rows are useless and each one is a credential-shaped thing sitting in a
// backup, so they go.
func sweepSessions(st *store.Store, log *slog.Logger) {
	for range time.Tick(time.Hour) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		n, err := st.DeleteExpiredSessions(ctx)
		cancel()
		if err != nil {
			log.Warn("session sweep", "err", err)
			continue
		}
		if n > 0 {
			log.Info("expired sessions removed", "count", n)
		}
	}
}

// sweepExpiredMessages burns messages past their deadline: a chat's own timer,
// or the installation-wide retention limit, whichever comes first.
//
// It runs even when no retention is configured, because a chat can carry its
// own timer regardless of what the operator set. Once a minute is often enough
// for a feature measured in hours and cheap enough to ignore: the scan is over
// an in-memory index.
func sweepExpiredMessages(st *store.Store, h *hub.Hub, cfg *config.Config, log *slog.Logger) {
	global := int64(cfg.RetentionDays) * 24 * 60 * 60
	for range time.Tick(time.Minute) {
		n, channels := st.ExpireMessages(time.Now().UnixMilli(), global)
		if n == 0 {
			continue
		}
		log.Info("expired messages removed", "count", n, "channels", len(channels))
		// Tell the affected chats to reload. A client still displaying
		// messages whose keys no longer exist anywhere looks like the app
		// losing data, not like a timer working.
		for _, id := range channels {
			ids, err := st.MemberIDs(context.Background(), id)
			if err != nil {
				continue
			}
			h.ToUsers(ids, hub.Event{Type: "channel.cleared", Channel: id})
		}
	}
}
