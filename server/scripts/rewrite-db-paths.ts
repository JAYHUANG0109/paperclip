// Rewrite absolute home paths stored in the DB after migrating to a new Mac with
// a DIFFERENT macOS username. The only place the DB stores an absolute path is
// each agent's adapter_config.env.ASANA_TOKEN_PATH (…/.paperclip/…). This swaps
// the old home prefix for the new one so agents find their Asana token files.
//
// Run AFTER `pnpm install` and AFTER the service/DB is up:
//   OLD_HOME=/Users/jayhuang server/node_modules/.bin/tsx server/scripts/rewrite-db-paths.ts
// NEW_HOME defaults to $HOME.
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const OLD = process.env.OLD_HOME;
const NEW = process.env.NEW_HOME || process.env.HOME;

async function main() {
  if (!OLD || !NEW) { console.error("✗ set OLD_HOME (and NEW_HOME or $HOME)."); process.exit(1); }
  if (OLD === NEW) { console.log("OLD_HOME === NEW_HOME — nothing to rewrite."); process.exit(0); }
  const db = createDb(DB_URL);
  // Generic text replace across the whole adapter_config JSON — catches
  // ASANA_TOKEN_PATH and any other absolute path that might be added later.
  const res = await db.execute(sql`
    update agents
    set adapter_config = replace(adapter_config::text, ${OLD}, ${NEW})::jsonb,
        updated_at = now()
    where adapter_config::text like ${"%" + OLD + "%"}
  `);
  const n = (res as unknown as { count?: number }).count ?? (Array.isArray(res) ? res.length : "?");
  console.log(`✓ Rewrote ${OLD} → ${NEW} in agents.adapter_config (${n} row(s)).`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message || e); process.exit(1); });
