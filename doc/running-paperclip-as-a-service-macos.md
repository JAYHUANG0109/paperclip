# Running Paperclip as an always-on service (macOS)

This Mac runs the Seasonarts Paperclip instance as a **launchd background service** so it
starts automatically at login, restarts automatically if it crashes, and is not tied to any
terminal or VS Code window. You should not have to start it by hand.

| | |
|---|---|
| Service label | `com.seasonarts.paperclip` |
| Service file | `~/Library/LaunchAgents/com.seasonarts.paperclip.plist` |
| Working directory | `~/paperclip/current` → a symlink to the **active release** |
| Releases | `~/paperclip/releases/<timestamp>-<sha8>` |
| Runs | `pnpm --filter @paperclipai/server exec tsx src/index.ts` — a production server that serves the pre-built UI bundle from `ui/dist` (no Vite dev server) |
| Health | `http://127.0.0.1:3100/` (expect HTTP 200) |
| Database | embedded PostgreSQL on port `54329`, data in `~/.paperclip/instances/default/db` (shared — only ever run ONE server) |
| Public URL | Tailscale Funnel → `http://127.0.0.1:3100`. Check the current hostname with `tailscale status`. |

## Deploy: `ops/deploy.sh`

> **Use `ops/deploy.sh`. Do NOT use `pnpm deploy:live`** — that path is retired and now
> hard-fails with a pointer here. It targeted `~/paperclip-live`, a layout from two machine
> migrations ago (`jayhuang` → `seasonart` → `seasonarts`) that does not exist on this Mac.

```bash
cd ~/dev/paperclip/paperclip

ops/deploy.sh deploy            # build origin/main into a new release, flip, health-check
ops/deploy.sh deploy <git-ref>  # deploy a specific tag/sha instead
ops/deploy.sh status            # current + previous release, and health
ops/deploy.sh rollback          # instant one-symlink revert to the previous release
ops/deploy.sh setup <branch>    # first-time setup on a fresh machine
```

**Deploy is blue-green.** Each deploy clones the resolved commit into a *new* release dir,
runs `pnpm install --frozen-lockfile`, runs the full `pnpm run build`, and asserts
`ui/dist` exists — all in isolation. Only if every step passes does it flip `current` and
restart. It then health-checks and **auto-rolls-back** (re-pointing `current` at the
previous release) if the site doesn't come back.

Safety properties:

- A broken build never reaches live — it's validated in the release dir before the flip.
- A bad boot never stays live — health check plus automatic rollback.
- The last good version is always one flip away (`PAPERCLIP_KEEP_RELEASES`, default 5).

**Deploy from pushed code.** `deploy` resolves `origin/<branch>`, so commit *and push*
first. Your working tree — finished or half-typed, across any number of tabs or worktrees —
can never reach production.

### ⚠️ Migration deploys are one-way

The server runs from TypeScript source via `tsx` and applies pending migrations at startup,
so **a deploy runs migrations**. `rollback` reverts *code*, not *schema* — you would land on
the old release running against the new schema. Treat any deploy carrying migrations as
one-way:

1. Rehearse it first. Migrations can silently no-op: drizzle compares only
   `max(created_at)` in `drizzle.__drizzle_migrations`, so anything stamped at or below that
   high-water-mark is skipped while `migrate` still exits 0.
2. Take a backup (`pnpm db:backup`) and keep it somewhere retention won't rotate it away.
3. After deploying, verify the migrations actually applied — don't infer it from a 200.

## Develop vs. deploy

| Folder | Role | You edit it? |
|---|---|---|
| `~/paperclip/releases/*` + `~/paperclip/current` | **Production.** The service runs here. | ❌ Never. Only `ops/deploy.sh` writes here. |
| `~/dev/paperclip/paperclip` | **Development.** Edit here, in as many tabs / worktrees as you like. | ✅ Yes |

For parallel tasks use a worktree per task: `git worktree add ../paperclip-taskname -b my-task`.

> **Why production is separate.** Earlier, live ran from the same folder being edited, so a
> half-finished change (e.g. mismatched i18n keys) blanked the app for everyone. Now live
> runs from an immutable release dir that only changes on deploy.

## What is automatic

| Situation | What happens |
|---|---|
| Mac reboots / you log in | Service auto-starts (`RunAtLoad`) |
| App crashes or is killed | launchd restarts it within ~15s (`KeepAlive`) |
| You close VS Code / terminals | App keeps running (not a child of them) |
| You edit or `git` files in `~/dev` | Live is completely unaffected |

## ⚠️ Do NOT run `pnpm dev` manually

The service already runs the app. A second copy conflicts on port `3100` and on the shared
embedded database. If you started one by hand, stop it and let the service own 3100.

## Quick reference

```bash
# Is it running? (PID, or '-' if stopped)
launchctl list | grep com.seasonarts.paperclip

# Force a clean restart
launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip

# Stop it (stays down until started or reboot)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.seasonarts.paperclip.plist

# Start after a manual stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.seasonarts.paperclip.plist

# Health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health

# Logs
tail -f ~/.paperclip/instances/default/logs/launchd-paperclip.out.log
tail -f ~/.paperclip/instances/default/logs/launchd-paperclip.err.log
```

## If the site is down

1. `ops/deploy.sh status` — shows current/previous release and health.
2. `launchctl list | grep com.seasonarts.paperclip` — PID means running; `-` means stopped.
3. `tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log`
4. `ops/deploy.sh rollback` if a recent deploy is the suspect (remember: code only, not schema).
5. `launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip` to force a clean restart.
6. Confirm: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health` → `200`.

## Environment overrides

`ops/deploy.sh` reads these (defaults shown):

```
PAPERCLIP_LAUNCHD_LABEL   com.seasonarts.paperclip
PAPERCLIP_DEPLOY_ROOT     $HOME/paperclip          # holds releases/, current, .repo.git
PAPERCLIP_REPO_URL        https://github.com/JAYHUANG0109/paperclip.git
PAPERCLIP_BRANCH          main
PAPERCLIP_HEALTH_URL      http://127.0.0.1:3100/
PAPERCLIP_HEALTH_TRIES     40
PAPERCLIP_KEEP_RELEASES     5
```

## Notes

- **Why `tsx` rather than a compiled server.** The plist runs the TypeScript server via
  `tsx`. A fully compiled server would be marginally lighter, but `pnpm build` fetches the
  `skills-catalog` manifest from GitHub at build time, which can fail and make rebuilds
  unreliable. Deploy tolerates this because the build runs in an isolated release dir and a
  failure aborts before the flip.
- **Historical:** an earlier failure had the database pointing at a moved repo copy
  (`~/Desktop/paperclip`), which broke the `pg_trgm` search extension and silently broke
  creating issues, comments, documents and routines (symptom: `could not access file
  "pg_trgm"`). Immutable release dirs plus the `current` symlink make that class of problem
  much harder to reproduce.
