#!/usr/bin/env sh
# Kivora build script for Linux and macOS.
#
#   ./build.sh              собрать сервер вместе с веб-клиентом
#   ./build.sh run          собрать и запустить
#   ./build.sh test         прогнать все тесты
#   ./build.sh desktop      собрать десктоп-приложение (нужен Rust)
#   ./build.sh release      кросс-компиляция под все платформы
#   ./build.sh package      три готовые поставки: сервер, Windows, Linux
#
# То же самое доступно через make: `make -f build.mk server`.
set -eu

cd "$(dirname "$0")"
TASK="${1:-server}"
VERSION="${VERSION:-0.1.0}"
LDFLAGS="-s -w -X github.com/kivora-im/kivora/server/internal/api.Version=${VERSION}"

need() {
	command -v "$1" >/dev/null 2>&1 || { echo "не найден $1: $2" >&2; exit 1; }
}

# Brand assets are committed, so this only runs when the artwork changed.
build_brand() {
	if [ ! -f web/public/brand/favicon.ico ]; then
		echo "› генерация логотипов из brand-source"
		npm install --no-audit --no-fund
		node scripts/brand.mjs
	fi
}

build_web() {
	need npm "установите Node.js 20+"
	build_brand
	echo "› сборка веб-клиента"
	# Vite is the normal path. On a host that cannot reach the npm registry
	# (air-gapped build, blocking proxy) fall back to bun, which bundles the
	# same sources into the same output shape.
	if npm --prefix web install --no-audit --no-fund >/dev/null 2>&1; then
		npm --prefix web run build
	elif command -v bun >/dev/null 2>&1; then
		echo "  реестр npm недоступен — собираю через bun"
		node scripts/build-web.mjs
	else
		echo "не удалось поставить зависимости веб-клиента и нет bun" >&2
		exit 1
	fi
	rm -rf server/internal/webui/dist
	cp -r web/dist server/internal/webui/dist
}

build_server() {
	need go "установите Go 1.24+"
	build_web
	echo "› сборка сервера"
	mkdir -p dist
	( cd server && go build -trimpath -ldflags "$LDFLAGS" -o ../dist/kivorad ./cmd/kivorad )
	echo "готово: dist/kivorad ($(du -h dist/kivorad | cut -f1))"
}

case "$TASK" in
web)     build_web ;;
server)  build_server ;;
run)     build_server; echo; echo "› запуск на http://localhost:8080"; exec ./dist/kivorad ;;
brand)
	npm install --no-audit --no-fund
	node scripts/brand.mjs
	;;
desktop)
	need cargo "установите Rust с https://rustup.rs"
	build_web
	npm --prefix desktop install --no-audit --no-fund
	npm --prefix desktop run build
	;;
test)
	need go "установите Go 1.24+"
	echo "› тесты сервера"
	( cd server && go vet ./... && go test -race ./... )
	echo "› тесты криптографии"
	( cd packages/kivora-crypto && npm install --no-audit --no-fund && npm test )
	echo "› проверка типов клиента"
	npm --prefix web install --no-audit --no-fund
	npm --prefix web run typecheck
	;;
release)
	build_web
	mkdir -p release
	for target in linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64; do
		os="${target%/*}"; arch="${target#*/}"; ext=""
		[ "$os" = "windows" ] && ext=".exe"
		echo "› $os/$arch"
		( cd server && GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
			go build -trimpath -ldflags "$LDFLAGS" -o "../release/kivorad-$os-$arch$ext" ./cmd/kivorad )
	done
	ls -lh release
	;;
package)
	# Three deliverables, because three different people download them: someone
	# putting Kivora on a server, someone installing it on Windows, someone
	# installing it on Linux. One folder holding all of it makes each of them
	# read past two thirds of it to find their part.
	sh "$0" release
	VERSION="$VERSION" sh scripts/package.sh
	;;
clean)
	rm -rf dist release web/dist desktop/src-tauri/target
	echo "очищено"
	;;
*)
	echo "неизвестная задача: $TASK" >&2
	echo "доступны: server, web, run, desktop, brand, test, release, package, clean" >&2
	exit 1
	;;
esac
