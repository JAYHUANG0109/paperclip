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

echo "▶ Installing launchd services (path fixup: $OLD_HOME → $HOME)…"
for p in "$STAGE"/LaunchAgents/*.plist; do
  [ -f "$p" ] || continue
  b="$(basename "$p")"
  sed "s#$OLD_HOME#$HOME#g" "$p" > "$LA/$b"
  echo "    installed $b"
done

rm -rf "$STAGE"
cat <<EOF

✓ Local state restored to ~/.paperclip and services installed (not started).

REMAINING STEPS on this Mac:
  1) Make sure the repo is cloned to match the service WorkingDirectory:
       git clone <repo> $HOME/paperclip-live && (cd $HOME/paperclip-live && git checkout <branch>)
  2) Install deps + build the UI once:
       cd $HOME/paperclip-live && pnpm install --frozen-lockfile && pnpm --filter @paperclipai/ui build
  3) Update DEVICE-SPECIFIC config (does not transfer):
       • Tailscale: this Mac has a different tailnet hostname — set up Tailscale + funnel.
       • scripts/deploy-live.sh: update PUBLIC_URL and LIVE=$HOME/paperclip-live.
       • Google OAuth redirect URIs, if the public hostname changed.
  4) Start the service:
       launchctl bootstrap gui/$UID_NUM $LA/com.seasonarts.paperclip.plist
       launchctl kickstart -k gui/$UID_NUM/com.seasonarts.paperclip
  5) Verify: open the dashboard, confirm agents + Asana tokens + digests work,
     then DELETE the bundle from both machines.
EOF
