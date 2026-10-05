#!/usr/bin/env sh
# Builds the three deliverables from an existing release/ directory.
#
# Three, not one, because three different people download them and each of them
# should find only their own half of the instructions:
#
#   kivora-server-<v>    an operator putting Kivora on a server
#   kivora-windows-<v>   someone running it on Windows 10/11
#   kivora-linux-<v>     someone running it on Linux
#
# Run through the build script rather than directly: `./build.sh package`.
set -eu

cd "$(dirname "$0")/.."
VERSION="${VERSION:-0.1.0}"

# NOT "packages/" — that is the source tree's own directory, holding
# kivora-crypto. An earlier version of this script wrote here and deleted the
# crypto library on its first run. A build output directory must never share a
# name with a source directory.
OUT="dist/packages"

[ -d release ] || { echo "нет release/ — сначала ./build.sh release" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

say() { printf '› %s\n' "$1"; }

# --------------------------------------------------------------- server

SRV="$OUT/kivora-server-$VERSION"
say "поставка для сервера"
mkdir -p "$SRV/bin" "$SRV/deploy"
cp release/kivorad-linux-amd64 "$SRV/bin/"
cp release/kivorad-linux-arm64 "$SRV/bin/"
cp deploy/Caddyfile deploy/nginx.conf deploy/Dockerfile deploy/docker-compose.yml \
   deploy/kivora.service "$SRV/deploy/"
cp web/public/404.html "$SRV/deploy/404.html"
cp LICENSE "$SRV/"
cp docs/DEPLOY.md docs/CORE-PROTECTION.md "$SRV/"
cp scripts/install-server.sh "$SRV/install.sh"
chmod +x "$SRV/bin/"* "$SRV/install.sh"
cp scripts/readme-server.md "$SRV/README.md"

# --------------------------------------------------------------- windows

WIN="$OUT/kivora-windows-$VERSION"
say "поставка для Windows"
mkdir -p "$WIN"
cp release/kivorad-windows-amd64.exe "$WIN/kivora.exe"
cp LICENSE "$WIN/"
cp scripts/readme-windows.md "$WIN/README.md"

# ----------------------------------------------------------------- linux

LIN="$OUT/kivora-linux-$VERSION"
say "поставка для Linux"
mkdir -p "$LIN"
cp release/kivorad-linux-amd64 "$LIN/kivora"
cp release/kivorad-linux-arm64 "$LIN/kivora-arm64"
cp LICENSE "$LIN/"
chmod +x "$LIN/kivora" "$LIN/kivora-arm64"
cp scripts/readme-linux.md "$LIN/README.md"

# --------------------------------------------------------------- archives

say "архивы"
( cd "$OUT" && tar czf "kivora-server-$VERSION.tar.gz" "kivora-server-$VERSION" )
( cd "$OUT" && tar czf "kivora-linux-$VERSION.tar.gz" "kivora-linux-$VERSION" )
if command -v zip >/dev/null 2>&1; then
	( cd "$OUT" && zip -qr "kivora-windows-$VERSION.zip" "kivora-windows-$VERSION" )
else
	( cd "$OUT" && tar czf "kivora-windows-$VERSION.tar.gz" "kivora-windows-$VERSION" )
	echo "  (нет zip — Windows-поставка упакована в tar.gz)" >&2
fi

# A checksum file is the cheapest thing an operator can verify, and the only
# defence a self-hosted download has against a mirror that lies.
( cd "$OUT" && sha256sum ./*.tar.gz ./*.zip 2>/dev/null > SHA256SUMS.txt || true )

ls -lh "$OUT"
