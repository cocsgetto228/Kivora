#!/usr/bin/env sh
# Installs Kivora as a systemd service. Idempotent: safe to re-run to upgrade.
#
#   sudo ./install.sh
#
# What it does, so nothing here is a surprise:
#   * creates a system user `kivora` with no shell and no home login
#   * copies the binary to /usr/local/bin/kivorad
#   * creates /var/lib/kivora, owned by that user, mode 0700
#   * installs and starts the systemd unit from deploy/kivora.service
#
# It deliberately does NOT set up TLS. Put Caddy or nginx in front — the
# configs are in deploy/ and DEPLOY.md explains why the server does not do
# certificates itself.
set -eu

cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "нужны права root: sudo ./install.sh" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo "нет systemd — смотрите README.md, раздел «Без systemd»" >&2; exit 1; }

case "$(uname -m)" in
	x86_64|amd64) BIN=bin/kivorad-linux-amd64 ;;
	aarch64|arm64) BIN=bin/kivorad-linux-arm64 ;;
	*) echo "нет готового бинарника для $(uname -m) — соберите из исходников" >&2; exit 1 ;;
esac

echo "› пользователь kivora"
id -u kivora >/dev/null 2>&1 || useradd --system --home /var/lib/kivora --shell /usr/sbin/nologin kivora

echo "› бинарник → /usr/local/bin/kivorad"
install -o root -g root -m 0755 "$BIN" /usr/local/bin/kivorad

echo "› каталог данных → /var/lib/kivora"
install -d -o kivora -g kivora -m 0700 /var/lib/kivora

echo "› systemd"
install -m 0644 deploy/kivora.service /etc/systemd/system/kivora.service
systemctl daemon-reload
systemctl enable kivora
systemctl restart kivora

sleep 1
systemctl --no-pager --lines=0 status kivora || true

cat <<'DONE'

Готово. Сервер слушает 127.0.0.1:8080 (см. /etc/systemd/system/kivora.service).

Дальше:
  1. Поставьте перед ним Caddy или nginx — конфиги в deploy/.
     Без TLS сквозное шифрование останется, но метаданные и токены пойдут открыто.
  2. Откройте адрес и зарегистрируйтесь: ПЕРВЫЙ аккаунт становится администратором.
  3. Закройте регистрацию, если сервер приватный:
       KIVORA_REGISTRATION=invite
       KIVORA_INVITE_CODES=...
     Переменные добавляются в юнит, строкой Environment=.

Настройки целиком — в DEPLOY.md.
DONE
