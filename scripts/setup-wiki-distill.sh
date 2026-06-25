#!/bin/zsh
# ---------------------------------------------------------------------------
# Portable installer for the daily wiki-distillation job (macOS launchd).
#
# Run this ONCE on whatever machine hosts Paperclip (laptop, Mac mini, ...).
# It auto-detects the repo location and the current user, generates the wrapper
# + launchd plist with the correct absolute paths, and loads the job. Re-running
# it safely reinstalls (idempotent). Nothing is hard-coded to one machine, so
# migrating hosts = copy the data, then run this on the new box.
#
# Usage:
#   ./scripts/setup-wiki-distill.sh                 # install at 23:59 daily
#   HOUR=2 MINUTE=30 ./scripts/setup-wiki-distill.sh   # custom time
#   ./scripts/setup-wiki-distill.sh --uninstall     # remove the job
# Optional env overrides (else uses portable defaults / plugin DB config):
#   PAPERCLIP_WIKI_ROOT, DATABASE_URL
# ---------------------------------------------------------------------------
set -e

LABEL="com.seasonarts.wiki-distill"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER_DIR="$HOME/.paperclip/scripts"
WRAPPER="$WRAPPER_DIR/run-wiki-distill.sh"
LOG="$HOME/.paperclip/wiki-distill.log"

# Resolve the repo root from this script's own location (portable).
SCRIPT_DIR="${0:A:h}"
REPO_DIR="${SCRIPT_DIR:h}"
TSX="$REPO_DIR/server/node_modules/.bin/tsx"
CRON_TS="$REPO_DIR/server/scripts/wiki-distill-cron.ts"

unload_job() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
}

if [[ "$1" == "--uninstall" ]]; then
  unload_job
  rm -f "$PLIST" "$WRAPPER"
  echo "Uninstalled $LABEL."
  exit 0
fi

if [[ ! -x "$TSX" ]]; then
  echo "ERROR: tsx not found at $TSX — run 'pnpm install' in the repo first." >&2
  exit 1
fi

HOUR="${HOUR:-23}"
MINUTE="${MINUTE:-59}"

mkdir -p "$WRAPPER_DIR" "$HOME/Library/LaunchAgents"

# Wrapper: sets a sane PATH (launchd has a minimal one), cd's to the repo, runs the runner.
cat > "$WRAPPER" <<WRAP
#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
${PAPERCLIP_WIKI_ROOT:+export PAPERCLIP_WIKI_ROOT="$PAPERCLIP_WIKI_ROOT"}
${DATABASE_URL:+export DATABASE_URL="$DATABASE_URL"}
cd "$REPO_DIR" || exit 1
"$TSX" "$CRON_TS" >> "$LOG" 2>&1
WRAP
chmod +x "$WRAPPER"

# launchd job
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$WRAPPER</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/.paperclip/wiki-distill.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.paperclip/wiki-distill.err.log</string>
</dict>
</plist>
PLISTEOF

unload_job
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL — runs daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE")."
echo "  repo:    $REPO_DIR"
echo "  wrapper: $WRAPPER"
echo "  log:     $LOG"
echo "Run a one-off now with: /bin/zsh \"$WRAPPER\" && tail -n 5 \"$LOG\""
