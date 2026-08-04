# Undocumented provider APIs we depend on

Some operator-facing features read data that the provider exposes to its own client but
publishes no contract for. These work, they are useful, and they **will** break without
notice. This file is the register of them, so that when one breaks the next person can tell
in a minute whether it is a real outage or a moved endpoint — instead of re-deriving it.

Rules for anything listed here:

1. **Fail soft.** A broken read must degrade to "unknown", never to a plausible-looking
   value. The feature disappears; nothing else does.
2. **Never gate correctness on it.** Nothing that decides whether work runs, who may see
   something, or what gets written may depend on one of these.
3. **Register it here** with the symptom you would actually see, and the check that
   distinguishes "moved" from "broken".

---

## `GET https://api.anthropic.com/api/oauth/usage`

**Used by:** the 5-hour / weekly usage bars on the Costs page's Account in use card.

**Code:** `fetchClaudeQuota()` and `fetchClaudeQuotaForConfigDir()` in
[quota.ts](../packages/adapters/claude-local/src/server/quota.ts), surfaced through
`describeClaudeRuntimeAccounts()` as `RuntimeAccountPoolEntry.quotaWindows`, rendered by
`QuotaBars` in [RuntimeAccountCard.tsx](../ui/src/components/RuntimeAccountCard.tsx).

**Auth:** the OAuth access token belonging to one `CLAUDE_CONFIG_DIR`. On macOS that token
is **not** in the config directory — there is no `.credentials.json` — it is a login-keychain
generic password named:

```
Claude Code-credentials-<first 8 hex of sha256(configDir)>
```

Read by shelling out to `/usr/bin/security`. That is deliberate: the keychain item's ACL is
granted to that binary, so it succeeds without a prompt. A native keychain binding is a
different caller, would prompt, and a prompt inside a launchd service hangs forever — taking
the Costs page with it. Files are still tried first, so hosts with file-based credentials
work unchanged.

**Response shape as of 2026-08-04:**

```json
{
  "five_hour": { "utilization": 82, "resets_at": "2026-08-04T12:49:59Z" },
  "seven_day": { "utilization": 54, "resets_at": "2026-08-04T23:59:59Z" },
  "seven_day_opus":   null,
  "seven_day_sonnet": null
}
```

`utilization` is a percentage. Only windows the provider actually reports are rendered.

### When it breaks

**Symptom:** usage bars vanish from the account card. Everything else — which account is in
use, pinning, rotation, agent runs — keeps working. No errors surface to users.

**Diagnose in one command.** Substitute the dir you care about:

```bash
DIR=~/.claude-accounts/acct2
SVC="Claude Code-credentials-$(printf %s "$DIR" | shasum -a 256 | cut -c1-8)"
TOKEN=$(security find-generic-password -s "$SVC" -w | python3 -c 'import json,sys; print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')
curl -s -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/api/oauth/usage \
  -H "authorization: Bearer $TOKEN" -H 'anthropic-beta: oauth-2025-04-20'
```

Note `$DIR` must be the **literal string** stored as the config dir (no trailing slash, not
a symlink-resolved variant) — the hash is over that exact string.

| Result | Meaning |
|---|---|
| `200` | endpoint fine; the bug is ours — check the parser in `quota.ts` |
| `401` | token expired. Normal, and handled: expired tokens short-circuit to null before the request. The account still runs fine; the CLI refreshes on use |
| `404` | **endpoint moved.** Find the new one: `strings "$(readlink -f "$(which claude)")" \| grep -oE '/api/[a-z0-9_/-]*usage[a-z0-9_/-]*'` |
| keychain read fails | the item name scheme changed, or the ACL no longer covers `/usr/bin/security`. Compare `security dump-keychain \| grep -i "claude code"` against the sha256 scheme above |

**Repair:** it is one URL and one response parser. Update both in `quota.ts`; the type
(`QuotaWindow`), the transport, and the UI do not need to change.

**Do not** add a retry loop or an alert for this. It is decoration on an operator page, and
`null` is a correct answer.

### Why not use something published instead

There isn't one. `policy-limits.json` in the config dir is policy restrictions, not
consumption. `claude auth status --json` returns identity and tier only. There is no
`claude usage` subcommand. Paperclip's own per-agent cost accounting is real and local, but
it measures spend against budgets rather than the provider's rate-limit windows — a
different number, and not the one that tells you an account is about to stop answering.
