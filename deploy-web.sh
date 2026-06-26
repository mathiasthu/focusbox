#!/usr/bin/env bash
# Build + deploy the Focusbox WEB APP to the VPS static root.
#
# FULLY ISOLATED from the API's deploy.sh (~/focusbox-sync/deploy.sh):
#   - different target dir (/var/www/focusbox-app, not /opt/focusbox-sync)
#   - this script only ever touches the web static root; it never restarts the API.
# Both use rsync --delete, so the targets MUST stay distinct (they are).
#
# Usage:   ./deploy-web.sh
# Configure the target host (no secrets in this public repo): either export the
# env vars below, or copy .deploy-web.env.example → .deploy-web.env (gitignored)
# and set them there. FOCUSBOX_VPS_HOST is REQUIRED.
#   FOCUSBOX_VPS_HOST=root@1.2.3.4 FOCUSBOX_VPS_PORT=22 ./deploy-web.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Optionally source local, gitignored deploy config (host/port/path).
if [ -f "$ROOT/.deploy-web.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/.deploy-web.env"
fi

if [ -z "${FOCUSBOX_VPS_HOST:-}" ]; then
  echo "✗ FOCUSBOX_VPS_HOST is not set." >&2
  echo "  Set it in the environment, or copy .deploy-web.env.example → .deploy-web.env" >&2
  echo "  (gitignored) and fill in FOCUSBOX_VPS_HOST (e.g. root@your.vps.ip)." >&2
  exit 1
fi

VPS_HOST="${FOCUSBOX_VPS_HOST}"
VPS_PORT="${FOCUSBOX_VPS_PORT:-22}"
DEST="${FOCUSBOX_WEB_PATH:-/var/www/focusbox-app}"

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

echo "→ smoke check: live CSP must allow WebAssembly (libsodium needs it for login/sync)…"
CSP=$(curl -fsS -m 10 -I "https://app.focusbox.net/" 2>/dev/null | tr -d '\r' | grep -i '^content-security-policy:' || true)
if echo "$CSP" | grep -qi "wasm-unsafe-eval"; then
  echo "  ✓ CSP allows wasm-unsafe-eval"
else
  echo "  ⚠️  WARNING: app.focusbox.net CSP is MISSING 'wasm-unsafe-eval' in script-src."
  echo "      libsodium's WebAssembly will be CSP-blocked → login/sync break with a silent"
  echo "      'cloud sync unavailable'. Fix the Apache vhost CSP on the VPS (see ~/focusbox-sync/DEPLOY.md)."
fi

echo "✓ web app deployed to ${DEST}. Apache serves it at https://app.focusbox.net"
echo "  (No API restart performed — this script is isolated from deploy.sh.)"
