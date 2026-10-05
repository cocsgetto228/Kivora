# Kivora build entry points (GNU make).
#
# Файл называется build.mk, а не Makefile: используйте `make -f build.mk <цель>`.
# На Windows удобнее build.ps1, на Linux и macOS — build.sh.
#
#   make            build everything for this machine
#   make server     one static binary with the web client inside it
#   make desktop    Tauri app for this platform
#   make test       everything the CI runs
#   make release    cross-compiled server binaries for the common targets
#
# The only tools required for `make server` are Go and Node. The desktop build
# additionally needs a Rust toolchain and the platform WebView dependencies —
# see docs/DEPLOY.md.

VERSION ?= 0.1.0
LDFLAGS := -s -w -X github.com/kivora-im/kivora/server/internal/api.Version=$(VERSION)
GO      ?= go
NPM     ?= npm

.PHONY: all server web desktop brand test test-go test-web test-crypto lint clean release run dev e2e

all: server

# ---------------------------------------------------------------- web client

brand:
	$(NPM) install
	node scripts/brand.mjs

web:
	@test -f web/public/brand/favicon.ico || $(MAKE) -f build.mk brand
	$(NPM) --prefix web install
	$(NPM) --prefix web run build
	rm -rf server/internal/webui/dist
	cp -r web/dist server/internal/webui/dist

# ------------------------------------------------------------------- server

# The web client is compiled into the binary, so deployment is one file.
server: web
	cd server && $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/kivorad ./cmd/kivorad
	@echo "built dist/kivorad ($$(du -h dist/kivorad | cut -f1))"

# Build without rebuilding the web client — the fast inner loop.
server-only:
	cd server && $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o ../dist/kivorad ./cmd/kivorad

run: server
	./dist/kivorad

dev:
	@echo "Run these in two terminals:"
	@echo "  1) cd server && go run ./cmd/kivorad"
	@echo "  2) cd web && npm run dev      # http://localhost:5173, proxies /api"

# ------------------------------------------------------------------ desktop

desktop: web
	$(NPM) --prefix desktop install
	$(NPM) --prefix desktop run build

# -------------------------------------------------------------------- tests

test: test-go test-crypto test-web

test-go:
	cd server && $(GO) vet ./... && $(GO) test -race ./...

test-crypto:
	cd packages/kivora-crypto && $(NPM) test

test-web:
	$(NPM) --prefix web run typecheck

# The browser end-to-end pass. Needs a running server: `make -f build.mk run`
# in another terminal first.
e2e:
	$(NPM) --prefix web install
	node web/e2e/smoke.mjs

lint:
	cd server && gofmt -l . && $(GO) vet ./...

# ------------------------------------------------------------------ release

# Cross-compiling the server needs no C toolchain: there is no cgo anywhere.
RELEASE_TARGETS := linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64

release: web
	@mkdir -p release
	@for target in $(RELEASE_TARGETS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		echo "building $$os/$$arch"; \
		( cd server && GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 \
			$(GO) build -trimpath -ldflags "$(LDFLAGS)" \
			-o ../release/kivorad-$$os-$$arch$$ext ./cmd/kivorad ); \
	done
	@ls -lh release

clean:
	rm -rf dist release web/dist server/internal/webui/dist desktop/src-tauri/target
	mkdir -p server/internal/webui/dist
	git checkout -- server/internal/webui/dist 2>/dev/null || true
