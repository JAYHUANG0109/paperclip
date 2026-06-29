#!/usr/bin/env bash
#
# Deploy the live Seasonarts Paperclip site.
#
# What it does:
#   1. Rebuilds the UI bundle (ui/dist) — required for any frontend change.
#   2. Restarts the launchd service, which serves that bundle and runs the
#      server from TS source (so backend changes are picked up by the restart too).
#
# Safety: if the UI build fails, the service is NOT restarted — the live site
# keeps serving the previous working bundle.
#
# Usage:  pnpm deploy:live   (or)   bash scripts/deploy-live.sh
#
set -euo pipefail

REPO="/Users/jayhuang/dev/paperclip/paperclip"
SERVICE="com.seasonarts.paperclip"
ROOT="http://127.0.0.1:3100"
HEALTH="$ROOT/api/health"
PUBLIC_URL="https://jays-macbook-pro.tailacdc6f.ts.net"

cd "$REPO"

echo "▶ [1/3] Building UI bundle (pnpm --filter @paperclipai/ui build)…"
if ! pnpm --filter @paperclipai/ui build; then
  echo "" >&2
  echo "✗ UI build FAILED — the service was NOT restarted." >&2
  echo "  The live site keeps serving the previous working build. Fix the build and re-run." >&2
  exit 1
fi

echo ""
echo "▶ [2/3] Restarting service ($SERVICE)…"
launchctl kickstart -k "gui/$(id -u)/$SERVICE"

echo ""
echo "▶ [3/3] Waiting for the site to come back healthy…"
for i in $(seq 1 45); do
  code="$(curl -s -m3 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    bundle="$(curl -s -m6 "$ROOT/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
    echo ""
    echo "✓ Deployed and healthy (took ~$((i * 2))s)."
    echo "  Serving bundle: ${bundle:-unknown}"
    echo "  Public URL:     $PUBLIC_URL"
    exit 0
  fi
  printf '%s.' "$code"
  sleep 2
done

echo "" >&2
echo "✗ Site did not return HTTP 200 after ~90s." >&2
echo "  Check the error log:" >&2
echo "    tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log" >&2
exit 1
