/**
 * Backfill: let every agent already wired to an `asana-connection.json` ALSO read
 * its responsible user's `ASANA_TOKEN` secret.
 *
 * Before this, the two stores were one-way: the Connections card wrote the file
 * and mirrored it into the user secret, but nothing ever read the secret back —
 * 36 agents were file-only and 0 declared ASANA_TOKEN, so rotating a token in
 * 我的密鑰 changed nothing and the agent kept 401ing on a frozen token.
 *
 * Adds `env.ASANA_TOKEN = { type: "user_secret_ref", key: "ASANA_TOKEN" }`
 * alongside the existing `ASANA_TOKEN_PATH` (the file stays — skills that read it
 * keep working) and syncs the declaration so the runtime can resolve it.
 * Idempotent: an agent that already has the binding is skipped.
 *
 *   tsx scripts/backfill-asana-user-secret-binding.ts            # dry-run
 *   tsx scripts/backfill-asana-user-secret-binding.ts --apply
 */
import { agents, createDb, eq } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { secretService } from "../server/src/services/secrets.js";
import { syncAgentAdapterEnvBindings } from "../server/src/services/agent-secret-bindings.js";
import { ASANA_USER_SECRET_KEY } from "../server/src/services/agent-asana.js";

const APPLY = process.argv.includes("--apply");

const BINDING = {
  type: "user_secret_ref",
  key: ASANA_USER_SECRET_KEY,
  version: "latest",
  required: false,
  allowMissingOverride: true,
} as const;

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const rows = await db.select().from(agents);
  const targets = rows.filter((a) => {
    const env = (a.adapterConfig as { env?: Record<string, unknown> } | null)?.env;
    return !!env && typeof env === "object" && "ASANA_TOKEN_PATH" in env;
  });

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} over ${targets.length} agents wired to an Asana token file\n`);
  let changed = 0;
  let skipped = 0;
  for (const a of targets) {
    const ac = { ...(a.adapterConfig as Record<string, unknown>) };
    const env = { ...((ac.env ?? {}) as Record<string, unknown>) };
    const existing = env[ASANA_USER_SECRET_KEY] as { type?: string } | undefined;
    if (existing && typeof existing === "object" && existing.type === "user_secret_ref") {
      skipped += 1;
      continue;
    }
    // A plain ASANA_TOKEN would be a hardcoded token; leave it alone and report
    // it rather than silently replacing a value someone deliberately set.
    if (existing !== undefined) {
      console.log(`  ! ${a.name}: env.${ASANA_USER_SECRET_KEY} already set to a non-ref value — left as is`);
      skipped += 1;
      continue;
    }
    changed += 1;
    console.log(`  · ${a.name}`);
    if (!APPLY) continue;

    env[ASANA_USER_SECRET_KEY] = BINDING;
    ac.env = env;
    await db.update(agents).set({ adapterConfig: ac, updatedAt: new Date() }).where(eq(agents.id, a.id));
    await syncAgentAdapterEnvBindings({
      secretsSvc: secretService(db),
      companyId: a.companyId,
      agentId: a.id,
      adapterConfig: ac,
    });
  }

  console.log(`\n${APPLY ? "updated" : "would update"} ${changed}, skipped ${skipped}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
