/**
 * Revoke one user's stored value for a user-secret definition.
 *
 * Written for the `local-board` case: the built-in Board account is the identity
 * runs fall back to when no real owner resolves, and it had accumulated an Asana
 * PAT — the founder's — so any agent that fell through was reaching Asana with
 * it. Deleting it is deliberate: an agent whose owner has no token of their own
 * should LOSE Asana access and fail visibly, not silently act as someone else.
 *
 * Only the named owner's copy is removed. Other users keep theirs, including the
 * person the token actually belongs to.
 *
 *   tsx scripts/revoke-user-secret.ts --owner local-board --key ASANA_TOKEN
 *   tsx scripts/revoke-user-secret.ts --owner local-board --key ASANA_TOKEN --apply
 */
import { createDb, sql } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { secretService } from "../server/src/services/secrets.js";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes("--apply");

async function main() {
  const owner = arg("owner");
  const key = arg("key");
  if (!owner || !key) throw new Error("need --owner <userId> --key <DEFINITION_KEY>");

  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const rows = (await db.execute(sql`
    select s.id, s.company_id, s.latest_version, s.status
    from company_secrets s
    join user_secret_definitions d on d.id = s.user_secret_definition_id
    where s.owner_user_id = ${owner} and d.key = ${key} and s.deleted_at is null
  `)) as unknown as Array<{ id: string; company_id: string; latest_version: number; status: string }>;

  if (rows.length === 0) {
    console.log(`nothing to revoke: ${owner} has no active ${key}`);
    process.exit(0);
  }

  for (const r of rows) {
    console.log(`${APPLY ? "revoking" : "would revoke"} ${key} for ${owner}: secret ${r.id} (v${r.latest_version}, ${r.status})`);
    if (APPLY) await secretService(db).remove(r.id);
  }
  if (!APPLY) console.log("\npass --apply to write");
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
