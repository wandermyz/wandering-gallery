#!/usr/bin/env bash
# Builds wandering-gallery and installs/updates the systemd user service.
# Safe to re-run for upgrades. Does not need root.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/wandering-gallery"
NODE="$(command -v node || true)"

if [[ -z "$NODE" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi
NODE="$(readlink -f "$NODE")"

cd "$APP_DIR"
echo "==> Installing dependencies"
npm ci --no-audit --no-fund
echo "==> Building"
npm run build

mkdir -p "$CONF_DIR" "$UNIT_DIR"
if [[ ! -f "$CONF_DIR/config.yaml" ]]; then
  cp config.example.yaml "$CONF_DIR/config.yaml"
  echo "==> Created $CONF_DIR/config.yaml - edit the library paths, then re-run this script."
  exit 0
fi

# PATH for the service: node's directory plus the usual places ffmpeg lives.
SVC_PATH="$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@NODE@|$NODE|g" -e "s|@PATH@|$SVC_PATH|g" \
  deploy/wandering-gallery.service > "$UNIT_DIR/wandering-gallery.service"

systemctl --user daemon-reload
systemctl --user enable wandering-gallery.service >/dev/null
systemctl --user restart wandering-gallery.service
sleep 2
systemctl --user --no-pager --lines=5 status wandering-gallery.service || true

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo
  echo "NOTE: lingering is off, so the service only runs while you are logged in."
  echo "      Enable start-at-boot with:  sudo loginctl enable-linger $USER"
fi
