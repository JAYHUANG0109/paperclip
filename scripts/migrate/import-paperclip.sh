#!/usr/bin/env bash
set -euo pipefail

# ── Paperclip migration: IMPORT (run on the NEW Mac) ─────────────────────────
# Restores the local Paperclip state from an export bundle, fixes launchd paths
# for this machine's home dir, and installs the services. Does NOT auto-start —
# you verify config first.
#
# PREREQS on the new Mac: Homebrew + node + pnpm + git installed; you've cloned
# the repo already (this script lives inside it).
#
# ⚠️  Absolute paths (token paths, log paths) are stored INSIDE the DB and files.
#     Keep the SAME macOS username as the old Mac and everything just works. If
#     the username differs, see README (DB path rewrite needed).
#
# Usage: scripts/migrate/import-paperclip.sh <bundle.tar.gz[.enc]>

BUNDLE="${1:?usage: import-paperclip.sh <bundle.tar.gz[.enc]>}"
[ -f "$BUNDLE" ] || { echo "✗ bundle not found: $BUNDLE" >&2; exit 1; }
UID_NUM="$(id -u)"; LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
STAGE="$(mktemp -d)"

case "$BUNDLE" in
  *.enc) echo "▶ Decrypting…"; openssl enc -d -aes-256-cbc -pbkdf2 -in "$BUNDLE" -out "$STAGE/bundle.tar.gz"; SRC="$STAGE/bundle.tar.gz" ;;
  *)     SRC="$BUNDLE" ;;
esac

echo "▶ Extracting…"; tar xzf "$SRC" -C "$STAGE"
[ -f "$STAGE/MANIFEST.txt" ] || { echo "✗ MANIFEST.txt missing — not a valid bundle." >&2; exit 1; }
OLD_HOME="$(awk '/^source_home:/{print $2}' "$STAGE/MANIFEST.txt")"
OLD_USER="$(awk '/^source_user:/{print $2}' "$STAGE/MANIFEST.txt")"
echo "── bundle manifest ──"; sed 's/^/    /' "$STAGE/MANIFEST.txt"; echo "─────────────────────"
echo "  restoring onto: home=$HOME user=$(whoami)"
if [ "$OLD_USER" != "$(whoami)" ]; then
  echo "⚠  Username differs ($OLD_USER → $(whoami)). Absolute paths in the DB (token paths)"
  echo "   will need rewriting after import — see scripts/migrate/README.md. Continuing."
fi

if [ -e "$HOME/.paperclip/instances" ]; then
  BAK="$HOME/.paperclip.bak-$(date +%Y%m%d-%H%M%S)"
  echo "⚠  ~/.paperclip/instances exists — moving current ~/.paperclip to $BAK"
  mv "$HOME/.paperclip" "$BAK"
fi

echo "▶ Restoring ~/.paperclip…"
mkdir -p "$HOME/.paperclip"
rsync -a "$STAGE/dot-paperclip/" "$HOME/.paperclip/"

# Rewrite the old home path in every TEXT file under ~/.paperclip (grep -Il skips
# binaries, so the Postgres data dir is untouched). Handles a different username
# on this Mac. The DB itself is rewritten separately (see the printed steps).
if [ "$OLD_HOME" != "$HOME" ]; then
  echo "▶ Rewriting $OLD_HOME → $HOME in instance text files…"
  grep -rIl --null "$OLD_HOME" "$HOME/.paperclip" 2>/dev/null \
    | xargs -0 -I{} sed -i '' "s#$OLD_HOME#$HOME#g" {} 2>/dev/null || true
fi

# Restore ~/.config/paperclip (funnel watchdog script + Chat sa.json) — the
# launchd plists point at these paths, so they must land before the services run.
if [ -d "$STAGE/dot-config-paperclip" ]; then
  echo "▶ Restoring ~/.config/paperclip…"
  mkdir -p "$HOME/.config/paperclip"
  rsync -a "$STAGE/dot-config-paperclip/" "$HOME/.config/paperclip/"
  if [ "$OLD_HOME" != "$HOME" ]; then
    grep -rIl --null "$OLD_HOME" "$HOME/.config/paperclip" 2>/dev/null \
      | xargs -0 -I{} sed -i '' "s#$OLD_HOME#$HOME#g" {} 2>/dev/null || true
  fi
fi

echo "▶ Installing launchd services (path fixup: $OLD_HOME → $HOME)…"
for p in "$STAGE"/LaunchAgents/*.plist; do
  [ -f "$p" ] || continue
  b="$(basename "$p")"
  sed "s#$OLD_HOME#$HOME#g" "$p" > "$LA/$b"
  echo "    installed $b"
done

# Leave a breadcrumb so setup-new-mac.sh knows whether a DB path-rewrite is needed
# (only when the macOS username differs).
echo "$OLD_HOME" > "$HOME/.paperclip/.migration-old-home" 2>/dev/null || true

rm -rf "$STAGE"
cat <<EOF

✓ Local state restored (~/.paperclip + ~/.config/paperclip) and launchd services
  installed (not started).

TIP: instead of the manual steps below, just run the one-shot wrapper — it does
all of this (build first release, cut over launchd, rewrite DB paths if needed,
health-check):
       scripts/migrate/setup-new-mac.sh <bundle>

REMAINING STEPS (if doing it by hand):
  1) Build the first release + cut launchd over to it (health-checked, auto-reverts):
       ops/deploy.sh setup
  2) If the macOS username DIFFERS from the old Mac, rewrite the DB's stored paths:
       OLD_HOME=$OLD_HOME \\
         \$HOME/paperclip/current/server/node_modules/.bin/tsx \\
         \$HOME/paperclip/current/server/scripts/rewrite-db-paths.ts
       launchctl kickstart -k gui/$UID_NUM/com.seasonarts.paperclip
     (Same username → skip this entirely.)
  3) Device-specific (does not transfer):
       • Tailscale: \`tailscale up\` to sign in. The funnel watchdog then
         auto-establishes the public funnel within ~60s (new tailnet hostname).
       • Google OAuth: add the new public hostname's redirect URI in Google Cloud,
         if the hostname changed.
  4) Verify: curl -s http://127.0.0.1:3100/api/health ; open the dashboard and
     confirm agents + Asana tokens + digests work. Then DELETE the bundle from
     both Macs.
EOF
