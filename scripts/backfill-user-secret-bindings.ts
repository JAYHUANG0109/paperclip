/**
 * Backfill: let every agent already wired to a connection FILE also read its
 * responsible user's live secret — ASANA_TOKEN and ODOO_API_KEY.
 *
 * Before this the two stores were one-way: the Connections card wrote the file
 * and mirrored it into the user secret, but nothing ever read the secret back —
 * 36 agents were file-only for Asana, 7 for Odoo, and 0 declared either. So
 * rotating a token in 我的密鑰 changed nothing and the agent kept 401ing on a
 * credential frozen at whatever the file last held.
 *
 * Adds `env.<KEY> = { type: "user_secret_ref", key: <KEY> }` alongside the
 * existing *_PATH entry (the file stays — skills that read it keep working) and
 * syncs the declaration so the runtime can resolve it. The ref is per-run and
 * per-responsible-user, so each agent still sees only its own owner's value.
 *
 * Idempotent: an agent that already has the ref is skipped, and a literal value
 * someone set by hand is reported rather than overwritten.
 *
 *   tsx scripts/backfill-user-secret-bindings.ts            # dry-run
 *   tsx scripts/backfill-user-secret-bindings.ts --apply
 */
import { agents, createDb, eq } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { secretService } from "../server/src/services/secrets.js";
import { syncAgentAdapterEnvBindings } from "../server/src/services/agent-secret-bindings.js";
import { ASANA_USER_SECRET_KEY } from "../server/src/services/agent-asana.js";
import { ODOO_USER_SECRET_KEY } from "../server/src/services/agent-odoo.js";

const APPLY = process.argv.includes("--apply");

/**
 * Each credential an agent can hold: the env var pointing at its connection FILE
 * (how we find agents that were wired the old way) and the user-secret key whose
 * live value should be injected alongside it.
 */
const CREDENTIALS = [
  { filePathEnvKey: "ASANA_TOKEN_PATH", secretKey: ASANA_USER_SECRET_KEY },
  { filePathEnvKey: "ODOO_CONNECTION_PATH", secretKey: ODOO_USER_SECRET_KEY },
] as const;

const binding = (key: string) =>
  ({ type: "user_secret_ref", key, version: "latest", required: false, allowMissingOverride: true }) as const;

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const rows = await db.select().from(agents);
  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} over ${rows.length} agents\n`);
  let changed = 0;
  let added = 0;
  let skipped = 0;

  for (const a of rows) {
    const ac = { ...(a.adapterConfig as Record<string, unknown>) };
    const env = { ...((ac.env ?? {}) as Record<string, unknown>) };
    const addedHere: string[] = [];

    for (const cred of CREDENTIALS) {
      // Only agents already wired to a connection file: those are the ones that
      // have a credential and currently read the frozen copy of it.
      if (!(cred.filePathEnvKey in env)) continue;
      const existing = env[cred.secretKey] as { type?: string } | undefined;
      if (existing && typeof existing === "object" && existing.type === "user_secret_ref") {
        skipped += 1;
        continue;
      }
      // A non-ref value is a literal someone deliberately set; report, never replace.
      if (existing !== undefined) {
        console.log(`  ! ${a.name}: env.${cred.secretKey} already set to a non-ref value — left as is`);
        skipped += 1;
        continue;
      }
      env[cred.secretKey] = binding(cred.secretKey);
      addedHere.push(cred.secretKey);
    }

    if (addedHere.length === 0) continue;
    changed += 1;
    added += addedHere.length;
    console.log(`  · ${a.name} → ${addedHere.join(", ")}`);
    if (!APPLY) continue;

    ac.env = env;
    await db.update(agents).set({ adapterConfig: ac, updatedAt: new Date() }).where(eq(agents.id, a.id));
    await syncAgentAdapterEnvBindings({
      secretsSvc: secretService(db),
      companyId: a.companyId,
      agentId: a.id,
      adapterConfig: ac,
    });
  }

  console.log(`\n${APPLY ? "updated" : "would update"} ${changed} agents (${added} bindings), skipped ${skipped}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
