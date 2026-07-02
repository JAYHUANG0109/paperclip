#!/usr/bin/env bash
#
# Package this Mac's running Paperclip into ONE archive to move to another Mac.
#
# Captures everything stateful: the instance dir (all agents, companies, tasks,
# the embedded Postgres DB, per-agent Asana tokens) AND the secrets .env that
# lives inside it (Google creds, BETTER_AUTH_SECRET, PAPERCLIP_AGENT_JWT_SECRET —
# these MUST match on the new Mac or sessions/agent JWTs invalidate), PLUS the
# launchd service definition. Code is intentionally NOT included — the new Mac
# rebuilds it fresh from git via `ops/deploy.sh setup` (see restore-on-new-mac.sh).
#
#   ops/migrate-to-new-mac.sh [output.tgz]
#
# Briefly stops the service to snapshot the DB consistently, then restarts it so
# THIS Mac keeps serving until you've verified the new one.
set -euo pipefail

LABEL="${PAPERCLIP_LAUNCHD_LABEL:-com.seasonarts.paperclip}"
INSTANCE_REL=".paperclip/instances/default"
INSTANCE="$HOME/$INSTANCE_REL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
OUT="${1:-$HOME/paperclip-migrate-$(date +%Y%m%d-%H%M%S).tgz}"
UID_NUM="$(id -u)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT

[ -d "$INSTANCE" ] || { echo "✗ instance dir not found: $INSTANCE"; exit 1; }
[ -f "$INSTANCE/.env" ] || echo "! warning: $INSTANCE/.env not found — secrets may be missing from the archive"

reload_launchd() {  # bootout (async) → wait for unload → bootstrap, retry once
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  local n=0; until ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || [ "$n" -ge 10 ]; do n=$((n+1)); sleep 1; done
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || { sleep 2; launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || true; }
}

echo "▸ Stopping the service for a consistent DB snapshot…"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
n=0; until ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || [ "$n" -ge 15 ]; do n=$((n+1)); sleep 1; done

echo "▸ Recording where this instance runs (branch / commit / funnel host)…"
{
  echo "branch=$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)"
  echo "origin=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null)"
  echo "funnel_host=$(/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null)"
  echo "node=$(node -v 2>/dev/null)  pnpm=$(pnpm -v 2>/dev/null)"
  echo "packaged_at=$(date -u +%FT%TZ)"
} > "$STAGE/MANIFEST.txt"

echo "▸ Packaging (~1 GB — mostly the embedded Postgres DB)…"
mkdir -p "$STAGE/payload/LaunchAgents"
[ -f "$PLIST" ] && cp "$PLIST" "$STAGE/payload/LaunchAgents/"
tar czf "$OUT" -C "$HOME" "$INSTANCE_REL" -C "$STAGE" "payload" "MANIFEST.txt"

echo "▸ Restarting the service on THIS Mac (keep it live until the new Mac is verified)…"
reload_launchd

echo
echo "✓ Wrote $OUT ($(du -h "$OUT" | cut -f1))"
sed 's/^/    /' "$STAGE/MANIFEST.txt"
echo
echo "Next:"
echo "  1. Copy $OUT to the new Mac (AirDrop / scp / Tailscale)."
echo "  2. On the new Mac:  ops/restore-on-new-mac.sh <that-file>"
echo "  3. Once the new Mac is verified, stop this one:"
echo "       launchctl bootout gui/$UID_NUM/$LABEL"
