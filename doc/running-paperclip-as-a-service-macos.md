# Running Paperclip as an always-on service (macOS)

This Mac runs the Seasonarts Paperclip instance as a **launchd background service** so it
**starts automatically at login, restarts automatically if it crashes, and is not tied to
any terminal or VS Code window**. You should not have to start it by hand.

- Public URL: `https://jays-macbook-pro.tailacdc6f.ts.net` (Tailscale Funnel → `http://127.0.0.1:3100`)
- Service label: `com.seasonarts.paperclip`
- Service file: `~/Library/LaunchAgents/com.seasonarts.paperclip.plist`
- Runs: `pnpm --filter @paperclipai/server exec tsx src/index.ts` from `/Users/jayhuang/dev/paperclip/paperclip` — a **production server** that serves the pre-built UI bundle from `ui/dist` (no Vite dev server). This is what makes the site load fast for remote users and mobile.
- Database: embedded PostgreSQL on port `54329`, data in `~/.paperclip/instances/default/db`

## What is now automatic (you don't do anything)

| Situation | What happens |
|---|---|
| Mac reboots / you log in | Service auto-starts (`RunAtLoad`) |
| App crashes or is killed | launchd restarts it within ~15s (`KeepAlive`) |
| You close VS Code / terminals | App keeps running (it's not a child of them) |
| You edit/`git` files in the repo | Live server is **not** disturbed (no-watch mode) |

## ⚠️ Do NOT run `pnpm dev` manually anymore

The service already runs the app. A second copy would conflict on port `3100` and break
things. If you ever started one by hand, stop it (`Ctrl-C` in that terminal) and let the
service own port 3100.

## Quick reference

```bash
# Is it running? (shows the PID, or '-' if stopped)
launchctl list | grep com.seasonarts.paperclip

# Restart it (e.g. after pulling new code — see "Applying changes" below)
launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip

# Stop it (won't come back until you start it or reboot)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.seasonarts.paperclip.plist

# Start it again after a manual stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.seasonarts.paperclip.plist

# Quick health check (expect HTTP 200)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health

# Logs
tail -f ~/.paperclip/instances/default/logs/launchd-paperclip.out.log
tail -f ~/.paperclip/instances/default/logs/launchd-paperclip.err.log
```

## Applying code changes

The service serves a **pre-built UI bundle** (production mode) and runs the server in
**no-watch** mode, so editing files does **not** change the live site until you rebuild
and restart. This is the trade-off for being fast for everyone (the old `dev:once` setup
hot-reloaded but was slow/unusable for remote users and phones). To deploy changes:

1. Pull / finish the code on this machine.
2. **Run one command** — it rebuilds the UI bundle and restarts the service (and aborts
   without restarting if the build fails, so a broken build never takes the site down):
   ```bash
   pnpm deploy:live
   ```
   This also picks up server/backend changes (the server runs from TypeScript source via
   `tsx`, so the restart alone applies them — no server build needed).

   The equivalent manual steps, if you ever need them:
   ```bash
   pnpm --filter @paperclipai/ui build
   launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip
   ```
   (`pnpm build` rebuilds everything but fetches the skills-catalog manifest from GitHub and
   can fail offline — the UI-only build in `deploy:live` avoids that.)

> **Develop elsewhere, not on the live tree.** Because this working directory *is* the
> live site, editing it mid-development can break production (e.g. a half-finished commit
> with mismatched i18n keys blanked the whole app once). For active development, use a
> separate checkout / your own `pnpm dev` server, then build + deploy here when ready.

## If the site is ever down

1. Check status: `launchctl list | grep com.seasonarts.paperclip`
   - Shows a PID → it's running; check the logs below.
   - Shows `-` or nothing → start it (see Quick reference) or just reboot.
2. Check the error log: `tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log`
3. Force a clean restart: `launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip`
4. Confirm health: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health` → expect `200`.

## Why this setup is robust

- **Pinned path.** The service always launches from `/Users/jayhuang/dev/paperclip/paperclip`.
  This permanently fixes an earlier failure where the database couldn't load its `pg_trgm`
  search extension because an old, moved copy of the repo (`~/Desktop/paperclip`) left the
  database pointing at a path that no longer existed. (Symptom was `could not access file
  "pg_trgm"`, which silently broke creating issues, comments, documents, and routines.)
  As long as the repo stays at this path, that can't recur.
- **Self-healing.** `KeepAlive` restarts the app on crash; `RunAtLoad` starts it at login.
- **Decoupled.** It does not depend on VS Code, a terminal, or a Claude session being open.

## Notes / future hardening

- The service runs the TypeScript server via `tsx` (no separate build step). A fully
  compiled production build (`pnpm build` → run `server/dist/index.js`) would be marginally
  lighter, but is **not** used here because the build fetches files from GitHub at build
  time (the `skills-catalog` manifest), which can fail and make rebuilds unreliable. The
  `tsx` no-watch setup avoids that fragility. If the catalog build is ever made offline-safe,
  switching to the compiled server is a clean upgrade (point the plist at
  `node /Users/jayhuang/dev/paperclip/paperclip/server/dist/index.js`).
