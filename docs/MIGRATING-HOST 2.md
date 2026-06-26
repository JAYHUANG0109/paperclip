# Migrating the Paperclip host (e.g. laptop → Mac mini)

The whole Paperclip deployment is portable. Moving it to another Mac is a copy +
one script, ~10 minutes. Nothing about the app is locked to a specific machine;
only a few **absolute paths** and the **OS-level daily job** are per-machine, and
the steps below handle both.

## What makes up a deployment
1. **The repo** — this git checkout (code).
2. **The embedded-Postgres data dir** — all companies, agents, issues, plugins,
   settings. Default: `~/.paperclip/...` (see `embeddedPostgresDataDir` in config).
3. **The wiki folder** — `/Users/<you>/seasonarts-wiki` (markdown the wiki serves).
4. **`~/.paperclip/`** — config, scripts, auth.
5. **The daily distill job** — a macOS `launchd` agent (regenerated per machine).

## Migration steps (on the NEW machine)
1. **Install prereqs:** Node (Homebrew), `pnpm`, git.
2. **Clone/copy the repo**, then `pnpm install` at the repo root.
3. **Copy the data dir** (`~/.paperclip` and the embedded-Postgres data dir) from
   the old machine to the same relative location on the new one. (Stop the old
   server first so Postgres is consistent.)
4. **Copy the wiki folder** to the new machine (e.g. `~/seasonarts-wiki`).
5. **Fix the stored wiki path** if the absolute path changed (different username):
   the LLM-wiki plugin stores its folder path in the DB. Update it to the new
   absolute path (one SQL/`tsx` update against `plugin_company_settings` →
   `localFolders["wiki-root"].path`). Ask Claude to run this — it's a 1-line patch.
6. **Start the server** the same way you do today.
7. **Reinstall the daily job** — this auto-detects the new repo path and user:
   ```sh
   ./scripts/setup-wiki-distill.sh
   ```
   (Custom time: `HOUR=2 MINUTE=30 ./scripts/setup-wiki-distill.sh`. Remove:
   `./scripts/setup-wiki-distill.sh --uninstall`.)

That's it. The distill runner (`server/scripts/wiki-distill-cron.ts`) reads the
wiki path from the plugin DB config, so once step 5 is right, the daily job needs
no path edits — `setup-wiki-distill.sh` handles the machine-specific bits.

## If you move to a dedicated always-on host
On a server you control the startup of, you can skip `launchd` entirely and use
the **in-server daily timer** (Phase 8): set these where the server launches and
the daily distill travels with the deployment:
```
PAPERCLIP_WIKI_DISTILL_ENABLED=true
PAPERCLIP_WIKI_ROOT=/absolute/path/to/seasonarts-wiki
PAPERCLIP_WIKI_DISTILL_COMPANY_ID=<company id>   # optional; omit = all companies
```
`launchd` is the right tool only because the dev laptop's server is never
restarted; a dedicated host should prefer the env-driven timer.
