#!/bin/bash
# Starts the asana-mcp server with the agent's Asana PAT.
# Token source, in priority order:
#   1. $ASANA_ACCESS_TOKEN — injected into the run env from the responsible
#      user's per-user secret ("My secrets", key ASANA_TOKEN). The single,
#      UI-managed source of truth.
#   2. $ASANA_TOKEN_PATH (JSON file) — legacy per-agent connection file, kept as
#      a fallback for agents whose user hasn't set a token in My secrets yet.
# Called by .claude/mcp.json so every agent run gets their own token.

set -e

if [ -z "$ASANA_ACCESS_TOKEN" ]; then
  # No injected per-user token — fall back to the legacy connection file.
  if [ -z "$ASANA_TOKEN_PATH" ] || [ ! -f "$ASANA_TOKEN_PATH" ]; then
    echo "[asana-mcp] No ASANA_ACCESS_TOKEN in env and no token file at ASANA_TOKEN_PATH — Asana MCP unavailable" >&2
    exit 1
  fi
  # Extract the PAT from the JSON file (supports "accessToken"/"token"/"access_token").
  ASANA_ACCESS_TOKEN=$(python3 -c "
import json, sys
with open('$ASANA_TOKEN_PATH') as f:
    d = json.load(f)
tok = d.get('accessToken') or d.get('token') or d.get('access_token') or ''
if not tok:
    sys.stderr.write('[asana-mcp] No token key found in $ASANA_TOKEN_PATH\n')
    sys.exit(1)
print(tok, end='')
")
fi

export ASANA_ACCESS_TOKEN
export ASANA_WRITE_ACCESS="${ASANA_WRITE_ACCESS:-restricted}"

exec npx --yes asana-mcp
