/**
 * One-time backfill: migrate each agent's legacy per-agent Asana token (the
 * loose ~/.paperclip/.../agents/<id>/asana-connection.json files) into the
 * responsible user's per-user secret ("My secrets", key ASANA_TOKEN).
 *
 * After this, an agent's Asana calls resolve the token from its responsible
 * user's per-user secret (see agent-asana.ts tokenFor); the file stays as a
 * fallback. Idempotent — skips a user who already has an ASANA_TOKEN value.
 *
 * Usage:
 *   cd server && npx tsx scripts/backfill-asana-user-secrets.ts [companyId]
 *   (omit companyId to process every company)
 *
 * DB URL: $SEED_DB_URL, else read the embedded-Postgres port from
 * ~/.paperclip/instances/default/db/postmaster.pid (line 4).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createDb, agents, companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { readToken, resolveAgentResponsibleUserId, ASANA_USER_SECRET_KEY } from "../src/services/agent-asana.js";
import { secretService } from "../src/services/secrets.js";
import { getConfiguredSecretProvider } from "../src/secrets/configured-provider.js";

function dbUrl(): string {
  if (process.env.SEED_DB_URL) return process.env.SEED_DB_URL;
  try {
    const pid = readFileSync(`${homedir()}/.paperclip/instances/default/db/postmaster.pid`, "utf8");
    const port = pid.split("\n")[3]?.trim();
    if (port) return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  } catch { /* fall through */ }
  return "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
}

async function ensureDefinition(svc: ReturnType<typeof secretService>, companyId: string): Promise<void> {
  const defs = await svc.listUserSecretDefinitions(companyId);
  if (defs.some((d: { key: string }) => d.key === ASANA_USER_SECRET_KEY)) return;
  await svc.createUserSecretDefinition(
    companyId,
    {
      key: ASANA_USER_SECRET_KEY,
      name: "Asana token",
      description: "Your personal Asana personal access token. Every agent you are responsible for uses it to read/post on Asana. Never shown back to anyone, including admins.",
      provider: getConfiguredSecretProvider(),
      usageGuidance: "Create a Personal Access Token at https://app.asana.com/0/my-apps and paste it here.",
    },
    { userId: null, agentId: null },
  );
  console.log(`  + created ASANA_TOKEN definition for company ${companyId}`);
}

async function backfillCompany(db: ReturnType<typeof createDb>, companyId: string): Promise<void> {
  const svc = secretService(db);
  const roster = await db.select().from(agents).where(eq(agents.companyId, companyId));
  if (roster.length === 0) return;

  let migrated = 0;
  let skipped = 0;
  let noToken = 0;
  let ensuredDef = false;

  for (const agent of roster) {
    const fileCfg = readToken(agent, companyId, agent.id);
    if (!fileCfg?.token) { noToken++; continue; }
    const userId = await resolveAgentResponsibleUserId(db, companyId, agent.id);
    if (!userId) {
      console.log(`  ~ ${agent.name}: has a file token but no responsible user (never ran) — left on file fallback`);
      skipped++;
      continue;
    }
    if (!ensuredDef) { await ensureDefinition(svc, companyId); ensuredDef = true; }

    // Idempotent: skip if this user already has an ASANA_TOKEN value.
    const existing = await svc.listCurrentUserSecretValues(companyId, userId);
    const already = existing.find((e: { definition: { key: string }; secret: unknown }) =>
      e.definition.key === ASANA_USER_SECRET_KEY && e.secret);
    if (already) { skipped++; continue; }

    await svc.createCurrentUserSecretValue(
      companyId,
      userId,
      { definitionKey: ASANA_USER_SECRET_KEY, value: fileCfg.token },
      { userId, agentId: null },
    );
    console.log(`  ✓ ${agent.name}: token → user ${userId}`);
    migrated++;
  }
  console.log(`company ${companyId}: migrated=${migrated} skipped(existing/no-user)=${skipped} agents-without-file-token=${noToken}`);
}

async function main() {
  const db = createDb(dbUrl());
  const arg = process.argv[2];
  const ids = arg
    ? [arg]
    : (await db.select({ id: companies.id }).from(companies)).map((c) => c.id);
  console.log(`Backfilling Asana user secrets across ${ids.length} company(ies)…`);
  for (const id of ids) await backfillCompany(db, id);
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
