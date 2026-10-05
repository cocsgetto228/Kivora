#!/usr/bin/env sh
# Bring up a working Kivora on this machine in one command.
#
#   ./scripts/quickstart.sh            # build and run on :8080
#   KIVORA_ADDR=:9000 ./scripts/quickstart.sh
#
# The first account that registers becomes the server's administrator.
set -eu

cd "$(dirname "$0")/.."

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "error: $1 is required but not installed" >&2
		exit 1
	}
}

need go
need npm

echo "› building the web client"
npm --prefix web install --silent
npm --prefix web run build

echo "› embedding it into the server"
rm -rf server/internal/webui/dist
cp -r web/dist server/internal/webui/dist

echo "› building the server"
mkdir -p dist
( cd server && go build -trimpath -ldflags "-s -w" -o ../dist/kivorad ./cmd/kivorad )

echo
echo "Kivora is built: dist/kivorad ($(du -h dist/kivorad | cut -f1))"
echo "Starting it on ${KIVORA_ADDR:-:8080} — open the address in a browser and register."
echo
exec ./dist/kivorad
