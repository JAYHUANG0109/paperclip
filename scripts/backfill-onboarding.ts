/**
 * Backfill: seed the 「🎓 上手教學」 onboarding 關卡 for every existing user-owned
 * agent that doesn't have it yet. Uses the SAME seedOnboardingForAgent service as
 * the agent-create hook, so behavior matches exactly. Idempotent + best-effort:
 * built-in / system-automation / owner-less agents are skipped.
 *
 *   tsx scripts/backfill-onboarding.ts            # dry-run (lists what would seed)
 *   tsx scripts/backfill-onboarding.ts --apply
 */
import { agents, createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { seedOnboardingForAgent } from "../server/src/services/onboarding.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const rows = (await db
    .select({ id: agents.id, companyId: agents.companyId, name: agents.name, status: agents.status })
    .from(agents))
    .filter((a) => a.status !== "terminated");

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} onboarding backfill over ${rows.length} agents\n`);
  const tally: Record<string, number> = {};
  for (const a of rows) {
    if (!APPLY) {
      // Dry-run: seedOnboardingForAgent is read-mostly until the writes; to avoid
      // side effects we only report the agent name here and rely on --apply's own
      // per-agent result line for the real classification.
      console.log(`  · ${a.name}`);
      continue;
    }
    let result: Awaited<ReturnType<typeof seedOnboardingForAgent>>;
    try {
      result = await seedOnboardingForAgent(db, { companyId: a.companyId, agentId: a.id });
    } catch (e) {
      result = { seeded: false, reason: "not-found" };
      console.log(`  ✗ ${a.name}: ERROR ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const key = result.seeded ? "seeded" : (result.reason ?? "skip");
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`  ${result.seeded ? "✓ SEEDED" : "· skip (" + result.reason + ")"}  ${a.name}${result.projectId ? `  → ${result.projectId}` : ""}`);
  }
  if (APPLY) console.log(`\nsummary: ${JSON.stringify(tally)}`);
  else console.log(`\nRe-run with --apply to seed. (built-in / 系統自動化 / owner-less / already-seeded are skipped by the service.)`);
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

void main().then(() => process.exit(0)).catch((e) => {
  console.error(`backfill failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
