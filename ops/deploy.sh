#!/usr/bin/env bash
#
# Blue-green deploy + rollback for the laptop-hosted Paperclip live instance.
#
# Live is the launchd service `com.seasonarts.paperclip`, whose WorkingDirectory
# is $ROOT/current — a symlink to the *active release*. Each deploy checks out a
# commit into a NEW release dir, installs deps, and TYPECHECKS it there. Only if
# that all passes does it flip `current` to the new release and restart; then it
# health-checks the live URL and AUTO-ROLLS-BACK (re-points `current` at the
# previous release) if the site doesn't come back. Old releases are kept so a
# manual `rollback` is an instant one-symlink revert.
#
# Safety properties:
#   • A broken build never reaches live  — validated in isolation before the flip.
#   • A bad boot never stays live          — health check + automatic rollback.
#   • The last good version is always 1 flip away (KEEP releases retained on disk).
#
# Usage:
#   ops/deploy.sh deploy [git-ref]   # default: origin/<BRANCH>; e.g. a tag or sha
#   ops/deploy.sh rollback           # revert to the previous release
#   ops/deploy.sh status             # show current/previous release + health
#
# Caveat: rollback reverts CODE. If a deploy applied a DB migration
# (PAPERCLIP_MIGRATION_AUTO_APPLY=true), rolling the code back may not match the
# migrated schema — treat migration deploys as one-way and test them first.
set -euo pipefail

LABEL="${PAPERCLIP_LAUNCHD_LABEL:-com.seasonarts.paperclip}"
ROOT="${PAPERCLIP_DEPLOY_ROOT:-$HOME/paperclip}"        # holds releases/, current, .repo.git
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
CACHE="$ROOT/.repo.git"
REPO_URL="${PAPERCLIP_REPO_URL:-https://github.com/JAYHUANG0109/paperclip.git}"
BRANCH="${PAPERCLIP_BRANCH:-fix/google-calendar-personal-filter}"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/}"
HEALTH_TRIES="${PAPERCLIP_HEALTH_TRIES:-40}"
KEEP="${PAPERCLIP_KEEP_RELEASES:-5}"
UID_NUM="$(id -u)"

log()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

restart() { launchctl kickstart -k "gui/$UID_NUM/$LABEL"; }
current_release() { readlink "$CURRENT" 2>/dev/null || true; }

healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    [ "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH_URL" 2>/dev/null)" = "200" ] && return 0
    sleep 1
  done
  return 1
}

ensure_cache() {
  mkdir -p "$RELEASES"
  if [ ! -d "$CACHE" ]; then
    log "Initializing repo cache at $CACHE"
    git clone --quiet --bare "$REPO_URL" "$CACHE"
  fi
  git --git-dir="$CACHE" fetch --quiet --prune origin "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"
}

prune_old() {
  # Keep the newest $KEEP releases (plus whatever current/previous point at).
  local keep_current keep_prev
  keep_current="$(current_release)"
  keep_prev="$(cat "$ROOT/.previous-release" 2>/dev/null || true)"
  # shellcheck disable=SC2012
  ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r d; do
    d="${d%/}"
    [ "$d" = "$keep_current" ] && continue
    [ "$d" = "$keep_prev" ] && continue
    rm -rf "$d"
  done
}

# Build + validate a release in its own dir WITHOUT touching live. Sets global
# REL to the built release path. Dies (leaving live untouched) on any failure.
REL=""
build_release() {
  local ref="${1:-origin/$BRANCH}"
  ensure_cache
  local sha
  sha="$(git --git-dir="$CACHE" rev-parse --verify --quiet "${ref#origin/}^{commit}" \
       || git --git-dir="$CACHE" rev-parse --verify --quiet "$ref^{commit}")" \
    || die "Cannot resolve git ref: $ref"

  local rel="$RELEASES/$(date +%Y%m%d-%H%M%S)-${sha:0:8}"
  log "Building release $(basename "$rel")  (commit ${sha:0:8})"
  git clone --quiet --shared "$CACHE" "$rel"
  git -C "$rel" -c advice.detachedHead=false checkout --quiet "$sha"

  log "Installing dependencies (pnpm install --frozen-lockfile)"
  ( cd "$rel" && pnpm install --frozen-lockfile ) || { rm -rf "$rel"; die "pnpm install failed — live untouched ($(basename "$(current_release)") still serving)"; }

  # Build the whole repo in topological order (pnpm run build): this builds the
  # dist-exporting packages the server imports at runtime (@paperclipai/plugin-sdk,
  # the plugins) AND the static UI bundle (ui/dist) the server serves. The server
  # itself runs from TS source via tsx, so its final gate is the post-flip health
  # check, not tsc. Everything happens in this isolated release dir; a failure
  # aborts before any flip (live untouched).
  log "Building repo (pnpm run build) — packages + UI bundle"
  ( cd "$rel" && pnpm run build ) || { rm -rf "$rel"; die "Build FAILED — live untouched ($(basename "$(current_release)") still serving)"; }
  [ -d "$rel/ui/dist" ] || { rm -rf "$rel"; die "Build produced no ui/dist — live untouched"; }

  REL="$rel"
}

deploy() {
  build_release "${1:-origin/$BRANCH}"
  local rel="$REL" prev
  prev="$(current_release)"
  log "Switching current → $(basename "$rel") and restarting"
  ln -sfn "$rel" "$CURRENT"
  restart

  if healthy; then
    [ -n "$prev" ] && echo "$prev" > "$ROOT/.previous-release"
    prune_old
    log "✓ Deployed & healthy: $(basename "$rel")${prev:+   (previous: $(basename "$prev"))}"
  else
    if [ -n "$prev" ] && [ -d "$prev" ]; then
      warn "New release unhealthy — AUTO-ROLLING BACK to $(basename "$prev")"
      ln -sfn "$prev" "$CURRENT"; restart
      if healthy; then die "Deploy failed; rolled back to $(basename "$prev") (live healthy again)"; fi
      die "Deploy failed AND rollback unhealthy — manual intervention needed"
    fi
    die "New release unhealthy and no previous release to roll back to"
  fi
}

# One-time migration: point the launchd service at the $CURRENT symlink instead
# of its original working dir, so future deploys are just a symlink flip. Builds
# + validates the first release BEFORE touching launchd; backs up the plist and
# auto-reverts to the original working dir if the new release doesn't come up.
setup() {
  local ref="${1:-origin/$BRANCH}"
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  [ -f "$plist" ] || die "launchd plist not found: $plist"
  if [ -L "$CURRENT" ]; then die "$CURRENT already exists — looks already set up; use 'deploy' instead."; fi

  build_release "$ref"
  local rel="$REL"
  ln -sfn "$rel" "$CURRENT"

  local old_wd; old_wd="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$plist")"
  log "Repointing launchd WorkingDirectory: $old_wd → $CURRENT"
  cp "$plist" "$plist.pre-deploy.bak"
  echo "$old_wd" > "$ROOT/.original-workdir"
  /usr/libexec/PlistBuddy -c "Set :WorkingDirectory $CURRENT" "$plist"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$plist"

  if healthy; then
    prune_old
    log "✓ Cutover complete — launchd now serves $CURRENT → $(basename "$rel")."
    log "  Original checkout kept as fallback at: $old_wd  (plist backup: $plist.pre-deploy.bak)"
  else
    warn "New release unhealthy — REVERTING launchd to $old_wd"
    /usr/libexec/PlistBuddy -c "Set :WorkingDirectory $old_wd" "$plist"
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$plist"
    healthy && die "Cutover failed; reverted to $old_wd (live healthy again)" \
             || die "Cutover failed AND revert unhealthy — restore $plist.pre-deploy.bak manually"
  fi
}

rollback() {
  local prev; prev="$(cat "$ROOT/.previous-release" 2>/dev/null || true)"
  [ -n "$prev" ] && [ -d "$prev" ] || die "No previous release recorded to roll back to"
  local cur; cur="$(current_release)"
  log "Rolling back current → $(basename "$prev")"
  ln -sfn "$prev" "$CURRENT"; restart
  if healthy; then
    [ -n "$cur" ] && echo "$cur" > "$ROOT/.previous-release"   # allow toggling back
    log "✓ Rolled back & healthy: $(basename "$prev")"
  else
    die "Unhealthy after rollback — manual intervention needed"
  fi
}

status() {
  echo "current : $(basename "$(current_release)" 2>/dev/null || echo '(none)')"
  echo "previous: $(basename "$(cat "$ROOT/.previous-release" 2>/dev/null || echo '(none)')")"
  echo "releases:"; ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's#.*/\([^/]*\)/#  \1#' | head -n "$KEEP"
  if [ "$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH_URL" 2>/dev/null)" = "200" ]; then
    echo "health  : OK ($HEALTH_URL)"
  else
    echo "health  : DOWN ($HEALTH_URL)"
  fi
}

case "${1:-}" in
  setup)    shift; setup "${1:-}";;
  deploy)   shift; deploy "${1:-}";;
  rollback) rollback;;
  status)   status;;
  *) echo "usage: $(basename "$0") setup [git-ref] | deploy [git-ref] | rollback | status"; exit 2;;
esac
