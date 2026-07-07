#!/usr/bin/env bash
set -euo pipefail

# ── Paperclip migration: ONE-SHOT NEW-MAC SETUP ──────────────────────────────
# Run this on the NEW Mac after cloning the repo. It does everything:
#   1. checks prerequisites (node/pnpm/git)
#   2. restores local state from the bundle (~/.paperclip + ~/.config/paperclip)
#      and installs the launchd services  (delegates to import-paperclip.sh)
#   3. builds the first release + cuts launchd over to it  (ops/deploy.sh setup)
#   4. rewrites DB-stored paths IF this Mac's username differs from the old one
#   5. health-checks, and tells you the one manual bit left (Tailscale sign-in)
#
# EASIEST PATH — make this Mac's macOS username the SAME as the old Mac's. Then
# step 4 is skipped entirely and nothing needs path-rewriting. If the username
# differs, this script still handles it automatically.
#
# Usage:
#   scripts/migrate/setup-new-mac.sh <bundle.tar.gz[.enc]>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UID_NUM="$(id -u)"
SERVICE="com.seasonarts.paperclip"
HEALTH="http://127.0.0.1:3100/api/health"
CURRENT="$HOME/paperclip/current"
BUNDLE="${1:?usage: setup-new-mac.sh <bundle.tar.gz[.enc]>}"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$BUNDLE" ] || die "bundle not found: $BUNDLE"

# 1. Prerequisites
step "[1/5] Checking prerequisites…"
missing=()
for c in node pnpm git; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ "${#missing[@]}" -gt 0 ]; then
  command -v brew >/dev/null 2>&1 || die "Missing ${missing[*]} — install Homebrew first (https://brew.sh), then: brew install ${missing[*]}"
  die "Missing ${missing[*]} — run: brew install ${missing[*]}"
fi
echo "  ✓ node $(node -v), pnpm $(pnpm -v), git $(git --version | awk '{print $3}')"

# 2. Restore local state + install services (reuses the tested import script).
step "[2/5] Restoring local state from bundle…"
"$SCRIPT_DIR/import-paperclip.sh" "$BUNDLE"
OLD_HOME="$(cat "$HOME/.paperclip/.migration-old-home" 2>/dev/null || echo "$HOME")"

# 3. Build the first release + cut launchd over to it. Idempotent-ish: if the
#    release symlink already exists we deploy instead of setup.
step "[3/5] Building first release + starting the service (pulls origin, builds — a few minutes)…"
if [ -L "$CURRENT" ]; then
  "$REPO_ROOT/ops/deploy.sh" deploy
else
  "$REPO_ROOT/ops/deploy.sh" setup
fi

# Point the funnel watchdog at the VERSIONED copy in the release (ops/…), not a
# loose ~/.config file, then reload it. Keeps the watchdog travelling with the
# code — one fewer moving part to bundle/rewrite on future migrations.
WD_PLIST="$HOME/Library/LaunchAgents/com.seasonarts.tailscale-funnel-watchdog.plist"
WD_SCRIPT="$CURRENT/ops/tailscale-funnel-watchdog.sh"
if [ -f "$WD_PLIST" ] && [ -f "$WD_SCRIPT" ]; then
  step "Pointing funnel watchdog at the versioned repo copy…"
  /usr/bin/python3 - "$WD_PLIST" "$WD_SCRIPT" <<'PY'
import plistlib, sys
plist_path, script = sys.argv[1], sys.argv[2]
with open(plist_path, "rb") as f: d = plistlib.load(f)
d["ProgramArguments"] = ["/bin/bash", script]
with open(plist_path, "wb") as f: plistlib.dump(d, f)
print(f"  ✓ watchdog → {script}")
PY
  launchctl bootout "gui/$UID_NUM/com.seasonarts.tailscale-funnel-watchdog" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$WD_PLIST" 2>/dev/null || true
fi

# 4. DB path rewrite — only when the username (home dir) differs.
if [ "$OLD_HOME" != "$HOME" ]; then
  step "[4/5] Username differs ($OLD_HOME → $HOME) — rewriting DB-stored paths…"
  TSX="$CURRENT/server/node_modules/.bin/tsx"
  if [ -x "$TSX" ]; then
    OLD_HOME="$OLD_HOME" "$TSX" "$CURRENT/server/scripts/rewrite-db-paths.ts" || \
      echo "  ⚠ DB path rewrite failed — run it manually (see scripts/migrate/RUNBOOK.md)."
    launchctl kickstart -k "gui/$UID_NUM/$SERVICE" 2>/dev/null || true
  else
    echo "  ⚠ tsx not found at $TSX — run the DB rewrite manually (see RUNBOOK.md)."
  fi
else
  step "[4/5] Same username as old Mac — no path rewriting needed. ✓"
fi

# 5. Health check + the one manual bit.
step "[5/5] Health check…"
ok=0
for _ in $(seq 1 20); do
  [ "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH" 2>/dev/null)" = "200" ] && { ok=1; break; }
  sleep 1
done
if [ "$ok" = 1 ]; then echo "  ✓ Local health OK ($HEALTH)"; else echo "  ⚠ Not healthy yet — check: tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log"; fi

cat <<EOF

────────────────────────────────────────────────────────────────────
✓ Setup done. One manual step remains (device-specific, can't transfer):

  • Tailscale — sign this Mac in:   tailscale up
    The funnel watchdog then auto-establishes the public funnel (~60s).
    This Mac gets a NEW tailnet hostname; if it changed, add that host's
    redirect URI to Google OAuth in Google Cloud console.

Then verify the dashboard (agents + Asana tokens + digests) and DELETE the
bundle from BOTH Macs (it holds secrets).
────────────────────────────────────────────────────────────────────
EOF
