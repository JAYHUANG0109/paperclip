#!/usr/bin/env bash
set -euo pipefail

# ── Paperclip migration: EXPORT ──────────────────────────────────────────────
# Bundles all LOCAL-ONLY Paperclip state into ONE archive to move to a new Mac:
#   • the embedded Postgres DB (agents, teams, routines, digests, schedule, …)
#   • secrets/master.key, per-agent Asana tokens, the instance .env
#   • agent instruction bundles (…/agents/*/instructions/AGENTS.md)
#   • workspaces (.claude/asana_client.py etc.), skills, uploaded assets
#   • the launchd service definitions
# Excludes bulky, regenerable data: DB backups, run logs, launchd logs.
#
# The DB is copied with the service stopped so it is consistent. All target Macs
# here are Apple Silicon on the same embedded Postgres major version, so a direct
# file copy is faithful.
#
# ⚠️  THE ARCHIVE CONTAINS SECRETS (tokens, master.key, .env, the whole DB).
#     Move it over AirDrop / USB / direct scp — never email or public cloud —
#     and delete it once the new machine is verified. Use --encrypt for a
#     passphrase-protected archive (recommended).
#
# Usage:
#   scripts/migrate/export-paperclip.sh [OUTPUT_DIR] [--encrypt]
#   (default OUTPUT_DIR: ~/Desktop)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UID_NUM="$(id -u)"
PAPERCLIP_HOME="${PAPERCLIP_HOME:-$HOME/.paperclip}"
SERVICE="com.seasonarts.paperclip"
LA="$HOME/Library/LaunchAgents"
PLISTS=(com.seasonarts.paperclip com.seasonarts.tailscale-funnel-watchdog com.seasonarts.wiki-distill)

OUT_DIR="$HOME/Desktop"; ENCRYPT=0
for a in "$@"; do case "$a" in --encrypt) ENCRYPT=1 ;; *) OUT_DIR="$a" ;; esac; done

[ -d "$PAPERCLIP_HOME/instances" ] || { echo "✗ $PAPERCLIP_HOME/instances not found — nothing to export." >&2; exit 1; }
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)/paperclip-bundle"
mkdir -p "$STAGE/dot-paperclip" "$STAGE/LaunchAgents"
ARCHIVE="$OUT_DIR/paperclip-migrate-$STAMP.tar.gz"

echo "▶ Stopping $SERVICE for a consistent DB snapshot…"
launchctl bootout "gui/$UID_NUM/$SERVICE" 2>/dev/null || true
sleep 5

restart_service() {
  echo "▶ Restarting $SERVICE…"
  launchctl bootstrap "gui/$UID_NUM" "$LA/$SERVICE.plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$UID_NUM/$SERVICE" 2>/dev/null || true
}
trap restart_service EXIT

echo "▶ Staging ~/.paperclip (excluding backups + logs)…"
rsync -a \
  --exclude 'instances/default/data/backups' \
  --exclude 'instances/default/data/run-logs' \
  --exclude 'instances/default/data/workspace-operation-logs' \
  --exclude 'instances/default/logs' \
  --exclude '*.bak-*' \
  "$PAPERCLIP_HOME/" "$STAGE/dot-paperclip/"

echo "▶ Staging launchd service definitions…"
for p in "${PLISTS[@]}"; do [ -f "$LA/$p.plist" ] && cp "$LA/$p.plist" "$STAGE/LaunchAgents/"; done

{
  echo "created: $STAMP"
  echo "source_home: $HOME"
  echo "source_user: $(whoami)"
  echo "arch: $(uname -m)"
  echo "macos: $(sw_vers -productVersion 2>/dev/null || true)"
  echo "node: $(node -v 2>/dev/null || true)"
  echo "pnpm: $(pnpm -v 2>/dev/null || true)"
  echo "pg_version: $(cat "$PAPERCLIP_HOME/instances/default/db/PG_VERSION" 2>/dev/null || true)"
  echo "repo_remote: $(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  echo "repo_branch: $(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || true)"
  echo "plists: ${PLISTS[*]}"
} > "$STAGE/MANIFEST.txt"

echo "▶ Creating archive…"
tar czf "$ARCHIVE" -C "$STAGE" .

restart_service
trap - EXIT

if [ "$ENCRYPT" = 1 ]; then
  echo "▶ Encrypting (choose a passphrase; you'll re-enter it on the new Mac)…"
  openssl enc -aes-256-cbc -pbkdf2 -salt -in "$ARCHIVE" -out "$ARCHIVE.enc"
  rm -f "$ARCHIVE"; ARCHIVE="$ARCHIVE.enc"
fi
rm -rf "$(dirname "$STAGE")"

echo ""
echo "✓ Bundle ready: $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"
echo "  1) Transfer it to the new Mac via AirDrop / USB / scp (it contains secrets)."
echo "  2) On the new Mac, from the cloned repo run:"
echo "       scripts/migrate/import-paperclip.sh <bundle>"
echo "  3) Delete the bundle from both machines once verified."
