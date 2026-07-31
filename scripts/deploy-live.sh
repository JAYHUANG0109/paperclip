#!/usr/bin/env bash
#
# RETIRED. Use `ops/deploy.sh deploy` instead.
#
# This script deployed to a dedicated production checkout at ~/paperclip-live and
# hardcoded LIVE="/Users/jayhuang/paperclip-live" — a path from two machine
# migrations ago (jayhuang -> seasonart -> seasonarts). That directory does not
# exist on the current host, so the script died with a confusing
# "Live checkout not found" instead of saying what to run instead.
#
# Production is now a blue-green release layout driven by ops/deploy.sh:
#   ~/paperclip/current -> ~/paperclip/releases/<timestamp>-<sha8>
# Each deploy builds the commit in an isolated release dir, flips the symlink
# only on success, health-checks, and auto-rolls-back on failure.
#
# See doc/running-paperclip-as-a-service-macos.md.
set -euo pipefail

cat >&2 <<'MSG'
✗ `pnpm deploy:live` / scripts/deploy-live.sh is RETIRED.

  Use instead:
    ops/deploy.sh deploy      # build origin/main, flip, health-check, auto-rollback
    ops/deploy.sh status      # current/previous release + health
    ops/deploy.sh rollback    # instant revert to the previous release

  Why: this script targeted ~/paperclip-live and hardcoded
  /Users/jayhuang/paperclip-live, which does not exist on this machine.
  Production now runs from ~/paperclip/current -> ~/paperclip/releases/<ts>-<sha>.

  Docs: doc/running-paperclip-as-a-service-macos.md

  Note: deploys apply pending DB migrations at startup, and rollback reverts
  code but NOT schema. Treat migration deploys as one-way and rehearse first.
MSG
exit 1
