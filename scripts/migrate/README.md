# Migrating Paperclip to another Mac

Most of what makes this deployment *yours* is **not in git** — it lives locally
under `~/.paperclip/` (the database, secrets, Asana tokens, per-agent `AGENTS.md`
instructions, workspaces, skills, uploaded assets) plus the launchd services.
These scripts bundle all of that so you can move it between machines.

Target chain: **M2 MacBook → M4 Pro Mac mini → M3 Ultra Mac Studio** — all Apple
Silicon on the same embedded Postgres major version, so a direct file copy of the
DB is faithful (no dump/restore needed).

## One rule that makes this painless: keep the same macOS username

Absolute paths are baked into the DB and token files (e.g. each agent's
`ASANA_TOKEN_PATH` points at `/Users/<you>/.paperclip/...`). If every Mac uses the
**same username**, home is `/Users/<you>` everywhere and nothing needs rewriting.
If the username changes, the launchd plists are auto-fixed by the import script,
but DB-stored absolute paths would also need rewriting — avoid that by keeping the
username consistent.

## Steps

**On the OLD Mac**
```bash
cd ~/dev/paperclip/paperclip        # (or ~/paperclip-live)
scripts/migrate/export-paperclip.sh ~/Desktop --encrypt
```
- Briefly stops the service to snapshot the DB, then restarts it.
- Produces `~/Desktop/paperclip-migrate-<stamp>.tar.gz.enc` (asks for a passphrase).
- Excludes bulky, regenerable data (DB backups, run logs).

**Transfer** the bundle via AirDrop / USB / `scp` (it contains secrets — never
email or public cloud).

**On the NEW Mac**
1. Install prereqs: Homebrew, `node`, `pnpm`, `git`.
2. Clone the repo to the two locations the setup expects:
   ```bash
   git clone <repo-url> ~/paperclip-live && (cd ~/paperclip-live && git checkout <branch>)
   git clone <repo-url> ~/dev/paperclip/paperclip   # dev checkout (optional)
   ```
3. Restore:
   ```bash
   cd ~/paperclip-live
   scripts/migrate/import-paperclip.sh ~/Downloads/paperclip-migrate-<stamp>.tar.gz.enc
   ```
4. Follow the printed checklist: `pnpm install` + build, update device-specific
   config (Tailscale hostname, `deploy-live.sh` `PUBLIC_URL`/`LIVE`, Google OAuth
   redirects), then start the service.
5. Verify the dashboard, agents, tokens, and digests — then **delete the bundle**
   from both machines.

## What transfers vs. what you re-set per device

| Transfers in the bundle | Re-set on each device |
|---|---|
| DB, secrets, tokens, `.env`, AGENTS.md, workspaces, skills, assets, plists | Tailscale hostname + funnel, `PUBLIC_URL`/`LIVE` paths, Google OAuth redirect URIs, Homebrew/node/pnpm install |

---

## "If I make the repo private, is it safe to push everything?"

**No — do not push secrets, tokens, `.env`, `master.key`, or the database to git,
even a private repo.** Private ≠ safe for secrets, because:

- Private repos still leak in practice — a mis-clicked visibility toggle, a fork, a
  collaborator's compromised laptop, a CI token, or a GitHub incident.
- Secrets committed to git are **permanent in history** — rotating them later
  doesn't remove them from old commits; you'd have to rewrite history everywhere.
- The DB and `asana-connection.json` hold live Asana PATs (act as those users) and
  potentially PII from tasks/comments. `master.key` decrypts stored secrets.

**Safe to push (private or public):** the application code, and — if you want them
version-controlled — the *content* of the `AGENTS.md` instruction files and the
`asana_client.py` (they're prompt text / code with **no secrets**). That actually
makes future migrations easier, since only the DB + tokens would remain bundle-only.

**Keep out of git, always:** `~/.paperclip/instances/*/db`, `secrets/master.key`,
any `.env`, and every `asana-connection.json`. Move those with the migration
bundle over a trusted channel — which is exactly what these scripts do.

> Tip: if you want the AGENTS.md edits (no-auto-comment, 12:00/16:00 schedule,
> refresh handler, comment-merge, subtasks) tracked in git for reproducibility, I
> can add a small seed script that writes them to the instance on setup — ask and
> I'll build it.
