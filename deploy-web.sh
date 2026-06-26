#!/usr/bin/env bash
# Build + deploy the Focusbox WEB APP to the VPS static root.
#
# FULLY ISOLATED from the API's deploy.sh (~/focusbox-sync/deploy.sh):
#   - different target dir (/var/www/focusbox-app, not /opt/focusbox-sync)
#   - this script only ever touches the web static root; it never restarts the API.
# Both use rsync --delete, so the targets MUST stay distinct (they are).
#
# Usage:   ./deploy-web.sh
# Override target via env:  FOCUSBOX_VPS_HOST=root@1.2.3.4 FOCUSBOX_VPS_PORT=22 ./deploy-web.sh
set -euo pipefail

VPS_HOST="${FOCUSBOX_VPS_HOST:-root@155.94.150.24}"
VPS_PORT="${FOCUSBOX_VPS_PORT:-52022}"
DEST="${FOCUSBOX_WEB_PATH:-/var/www/focusbox-app}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "→ building web bundle (tsc && vite build)…"
( cd "$ROOT" && npm run build )

echo "→ CSP gate…"
( cd "$ROOT" && npm run check:csp )

echo "→ rsync  $ROOT/dist/  →  ${VPS_HOST}:${DEST}  (ssh port ${VPS_PORT})"
rsync -az --delete \
  -e "ssh -p ${VPS_PORT}" \
  "$ROOT/dist/" "${VPS_HOST}:${DEST}/"

echo "→ post-push chown (read-only to Apache: root:www-data 755)…"
ssh -p "${VPS_PORT}" "${VPS_HOST}" \
  "chown -R root:www-data '${DEST}' && find '${DEST}' -type d -exec chmod 755 {} + && find '${DEST}' -type f -exec chmod 644 {} +"

echo "✓ web app deployed to ${DEST}. Apache serves it at https://app.focusbox.net"
echo "  (No API restart performed — this script is isolated from deploy.sh.)"
