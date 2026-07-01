# New-Mac setup runbook (for Claude Code on the target Mac)

You are Claude Code on a **fresh Mac** that will run the Paperclip platform. A
migration bundle from the old Mac has been transferred here. Follow these steps
in order. This Mac is a shared/office Mac, so its **username differs** from the
old one — the steps below handle that (paths get rewritten automatically).

Ask the user for: (a) the path to the bundle file (e.g. `~/Downloads/paperclip-migrate-*.tar.gz.enc`),
(b) the git remote URL + branch, (c) the decryption passphrase if the bundle is `.enc`.

## 0. Prereqs (install if missing)
```bash
# Homebrew, then:
brew install node pnpm git
```

## 1. Clone the repo (two checkouts — dev + live)
```bash
git clone <REMOTE> ~/paperclip-live && (cd ~/paperclip-live && git checkout <BRANCH>)
git clone <REMOTE> ~/dev/paperclip/paperclip   # optional dev checkout
```

## 2. Restore the local state from the bundle
```bash
cd ~/paperclip-live
scripts/migrate/import-paperclip.sh <BUNDLE_PATH>
```
This restores `~/.paperclip`, rewrites the old home path in all text files to
this Mac's `$HOME`, and installs the launchd services. Note the `OLD_HOME` it
prints — you need it in step 4.

## 3. Install deps + build
```bash
cd ~/paperclip-live && pnpm install --frozen-lockfile && pnpm --filter @paperclipai/ui build
```

## 4. Start the DB, then rewrite the DB's stored paths (different username)
```bash
UID_NUM=$(id -u)
launchctl bootstrap gui/$UID_NUM ~/Library/LaunchAgents/com.seasonarts.paperclip.plist
# wait ~10s for embedded Postgres to come up, then:
OLD_HOME=<OLD_HOME_FROM_STEP_2> server/node_modules/.bin/tsx server/scripts/rewrite-db-paths.ts
launchctl kickstart -k gui/$UID_NUM/com.seasonarts.paperclip
```

## 5. Device-specific config (does NOT transfer)
- **Tailscale**: install + sign in; set up the funnel. This Mac gets a new
  tailnet hostname.
- **`scripts/deploy-live.sh`**: update `PUBLIC_URL` to the new hostname and
  confirm `LIVE=$HOME/paperclip-live`.
- **Google OAuth**: if the public hostname changed, add the new redirect URI in
  the Google Cloud console.

## 6. Verify
```bash
curl -s -m5 http://127.0.0.1:3100/api/health
```
Open the dashboard, confirm: agents list, Asana tokens work (a 更新 on a console
pulls fresh data), digests render. Then **delete the bundle** from this Mac and
the old one.

## Sanity checks
- No leftover old-home paths in the DB:
  `OLD_HOME=<OLD_HOME> server/node_modules/.bin/tsx server/scripts/rewrite-db-paths.ts` should report `0 row(s)` on a second run.
- Agents can read tokens: trigger a console 更新 and confirm it doesn't error with
  "can't find token".
