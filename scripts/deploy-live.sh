#!/usr/bin/env bash
#
# Deploy the live Seasonarts Paperclip site.
#
# Production runs from a DEDICATED checkout (~/paperclip-live) that nobody edits.
# You develop in ~/dev/paperclip/paperclip (or per-task git worktrees), commit,
# and PUSH. This script then pulls the pushed code on the production branch into
# the live checkout, rebuilds, and restarts the service.
#
# Because it deploys only committed+pushed code from a separate checkout, your
# in-progress edits (in any tab/worktree) can never reach or break production.
# If the build fails, the service is NOT restarted — the live site keeps serving
# the previous working build.
#
# Usage:  pnpm deploy:live      (or)   bash scripts/deploy-live.sh
#
set -euo pipefail

LIVE="/Users/jayhuang/paperclip-live"
SERVICE="com.seasonarts.paperclip"
ROOT="http://127.0.0.1:3100"
HEALTH="$ROOT/api/health"
PUBLIC_URL="https://jays-macbook-pro.tailacdc6f.ts.net"

if [ ! -d "$LIVE/.git" ]; then
  echo "✗ Live checkout not found at $LIVE. Set it up first." >&2
  exit 1
fi

cd "$LIVE"
BRANCH="$(git branch --show-current)"

echo "▶ [1/4] Pulling pushed code on '$BRANCH' into the live checkout…"
git fetch --quiet origin "$BRANCH"
BEFORE="$(git rev-parse --short HEAD)"
git reset --hard --quiet "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
echo "  $BEFORE → $AFTER"

echo "▶ [2/4] Installing dependencies (fast if unchanged)…"
pnpm install --frozen-lockfile --prefer-offline >/tmp/deploy-live-install.log 2>&1 \
  || { echo "✗ Dependency install failed — NOT restarting. See /tmp/deploy-live-install.log" >&2; exit 1; }

echo "▶ [3/4] Building the UI bundle…"
# UI-only build: the server runs from TS source via tsx (no server build needed),
# and the workspace packages were built during setup. We deliberately do NOT run the
# full `pnpm build` here because it re-fetches the skills-catalog manifest from GitHub
# every time and fails when GitHub is unreachable/rate-limited. If you ever change a
# workspace package (packages/*), run a full `pnpm build` in ~/paperclip-live manually.
if ! pnpm --filter @paperclipai/ui build; then
  echo "" >&2
  echo "✗ UI build FAILED — the service was NOT restarted." >&2
  echo "  The live site keeps serving the previous working build. Fix and re-run." >&2
  exit 1
fi

echo ""
echo "▶ [4/4] Restarting service ($SERVICE)…"
launchctl kickstart -k "gui/$(id -u)/$SERVICE"

for i in $(seq 1 45); do
  code="$(curl -s -m3 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    bundle="$(curl -s -m6 "$ROOT/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
    echo ""
    echo "✓ Deployed $AFTER and healthy (~$((i * 2))s)."
    echo "  Serving bundle: ${bundle:-unknown}"
    echo "  Public URL:     $PUBLIC_URL"
    exit 0
  fi
  printf '%s.' "$code"
  sleep 2
done

echo "" >&2
echo "✗ Site did not return HTTP 200 after ~90s." >&2
echo "  Check: tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log" >&2
exit 1
