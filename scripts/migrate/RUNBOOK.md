# New-Mac migration — the simple version

Moving the Paperclip live instance to another Mac is now **2 commands on the old
Mac + 3 on the new one.** A one-shot script does the heavy lifting.

## 🔑 The single biggest time-saver: use the SAME macOS username

Absolute paths (Asana token paths, log paths) are baked into the DB, files, and
launchd plist. If the new Mac's **username matches the old one, ZERO path
rewriting is needed** and everything just works. Create a matching account on the
new Mac (e.g. same short name) before you start. If it differs, the scripts still
handle it automatically — it's just one extra rewrite step.

---

## On the OLD Mac (2 commands)
```bash
cd ~/dev/paperclip/paperclip           # your dev checkout
scripts/migrate/export-paperclip.sh --encrypt
```
This stops the service briefly for a consistent snapshot, bundles **everything
local + secret** (embedded Postgres DB, master.key, per-agent Asana tokens, the
`.env`, agent `AGENTS.md`, skills, assets, `~/.config/paperclip` funnel watchdog +
Chat key, and the launchd plists), then restarts the service. You'll get:

    ~/Desktop/paperclip-migrate-<stamp>.tar.gz.enc

**AirDrop / USB / scp** it to the new Mac (never email/cloud — it holds secrets).

## On the NEW Mac (3 commands)
```bash
# 1. Prereqs (skip any you already have)
brew install node pnpm git

# 2. Clone the repo (dev checkout — where you run scripts / edit code)
git clone https://github.com/JAYHUANG0109/paperclip.git ~/dev/paperclip/paperclip
cd ~/dev/paperclip/paperclip && git checkout main

# 3. One-shot setup (restore + build first release + start + verify)
scripts/migrate/setup-new-mac.sh ~/Downloads/paperclip-migrate-<stamp>.tar.gz.enc
```
`setup-new-mac.sh` does all of this for you:
1. checks prerequisites
2. restores `~/.paperclip` + `~/.config/paperclip` and installs the launchd services
3. `ops/deploy.sh setup` — builds the first release, cuts launchd over to
   `~/paperclip/current`, starts it (health-checked, **auto-reverts** if unhealthy)
4. rewrites DB-stored paths **only if** the username differs
5. health-checks and prints the one remaining manual step

## The one manual step left
```bash
tailscale up          # sign this Mac into the tailnet
```
The **funnel watchdog auto-establishes the public funnel within ~60s** (this Mac
gets a new tailnet hostname). If the public hostname changed, add its redirect URI
to Google OAuth in the Google Cloud console.

## Verify, then clean up
```bash
curl -s http://127.0.0.1:3100/api/health          # expect {"status":"ok",...}
```
Open the dashboard → confirm agents list, Asana tokens (run a console 更新), and
digests render. Then **delete the bundle from both Macs.**

---

## Deploys after migration
Live is served from `~/paperclip/current` (a symlink to the active release).
Ship code with **`ops/deploy.sh deploy`** — never `pnpm deploy:live` (retired; it
updates an unused checkout). `ops/deploy.sh status` shows current/previous/health;
`ops/deploy.sh rollback` is an instant one-symlink revert.

## If something's off
- **Not healthy:** `tail -50 ~/.paperclip/instances/default/logs/launchd-paperclip.err.log`
- **Agents can't find tokens (username differed):** the DB path rewrite didn't run —
  `OLD_HOME=<old> ~/paperclip/current/server/node_modules/.bin/tsx ~/paperclip/current/server/scripts/rewrite-db-paths.ts`
  then `launchctl kickstart -k gui/$(id -u)/com.seasonarts.paperclip`. Re-running it
  reports `0 row(s)` once clean.
- **"pg_trgm / $libdir" DB errors:** restart the service (embedded Postgres stale-lib quirk).
