#!/usr/bin/env bash
#
# Restore a Paperclip instance packaged by migrate-to-new-mac.sh onto THIS Mac,
# fetch the matching code, and print the final one-time networking/secret steps.
# It does the mechanical restore automatically; it does NOT flip networking or
# touch Google OAuth (those need your judgement — see the printed steps).
#
#   ops/restore-on-new-mac.sh <paperclip-migrate-*.tgz> [repo-dir]
#
set -euo pipefail

ARCHIVE="${1:?usage: restore-on-new-mac.sh <paperclip-migrate-*.tgz> [repo-dir]}"
LABEL="${PAPERCLIP_LAUNCHD_LABEL:-com.seasonarts.paperclip}"
[ -f "$ARCHIVE" ] || { echo "✗ archive not found: $ARCHIVE"; exit 1; }

echo "▸ Checking tooling…"
for c in git node pnpm; do command -v "$c" >/dev/null || { echo "✗ missing '$c' — install with: brew install $c"; exit 1; }; done
command -v claude >/dev/null 2>&1 \
  || echo "! 'claude' not on PATH — install the Claude CLI, then: ln -sf ~/.local/bin/claude /opt/homebrew/bin/claude"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
tar xzf "$ARCHIVE" -C "$STAGE"
echo "▸ Manifest:"; sed 's/^/    /' "$STAGE/MANIFEST.txt" 2>/dev/null || echo "    (none)"
BRANCH="$(grep -E '^branch=' "$STAGE/MANIFEST.txt" 2>/dev/null | cut -d= -f2)"
ORIGIN="$(grep -E '^origin=' "$STAGE/MANIFEST.txt" 2>/dev/null | cut -d= -f2)"

echo "▸ Restoring instance state → ~/.paperclip/instances/default (incl. DB + secrets .env)…"
mkdir -p "$HOME/.paperclip/instances"
if [ -e "$HOME/.paperclip/instances/default" ]; then
  mv "$HOME/.paperclip/instances/default" "$HOME/.paperclip/instances/default.bak-$(date +%s)"
fi
cp -R "$STAGE/.paperclip/instances/default" "$HOME/.paperclip/instances/default"

echo "▸ Restoring launchd service definition…"
mkdir -p "$HOME/Library/LaunchAgents"
[ -f "$STAGE/payload/LaunchAgents/$LABEL.plist" ] && cp "$STAGE/payload/LaunchAgents/$LABEL.plist" "$HOME/Library/LaunchAgents/"

REPO_DIR="${2:-$HOME/dev/paperclip/paperclip}"
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "▸ Cloning ${ORIGIN:?no origin in manifest} → $REPO_DIR"
  git clone "$ORIGIN" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch origin --quiet || true
[ -n "$BRANCH" ] && git -C "$REPO_DIR" checkout "$BRANCH" 2>/dev/null || true

cat <<EOF

✓ State + code restored. Two one-time manual steps remain (they can't be safely scripted):

  1) Networking — new Mac = new Tailscale hostname:
       tailscale up                       # sign in
       tailscale funnel 3100              # or your configured port
     The public URL changes, so update:
       - ~/.paperclip/instances/default/.env
           PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://<new-host>.ts.net
           PAPERCLIP_ALLOWED_HOSTNAMES=<new-host>.ts.net
       - Google Cloud Console → OAuth client → add redirect URI for the new host.

  2) If THIS Mac's home path differs, edit the launchd plist accordingly:
       ~/Library/LaunchAgents/$LABEL.plist   (WorkingDirectory / HOME / PATH)

Then build + start via the deploy pipeline (blue-green, health-checked):
       cd "$REPO_DIR" && ops/deploy.sh setup ${BRANCH:-<branch>}

Verify: site loads over the new funnel · Google login works · an agent run
succeeds (claude resolved) · calendar + skills render.
EOF
