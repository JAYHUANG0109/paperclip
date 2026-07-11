/**
 * One-off cleanup: REMOVE the AI auto-comments that founder/園長 console agents
 * posted to Asana. Scans every agent that carries a founder/園長 digest and, for
 * each task in those digests (and its private-link inner task), deletes only the
 * stories tagged with the AI auto-comment marker — using that agent's OWN token
 * (the only token allowed to delete its own comments).
 *
 * SAFE BY DEFAULT: dry-run. It prints exactly what WOULD be deleted and touches
 * nothing until you pass --apply. It never changes task state (completions /
 * approvals) and never deletes human comments.
 *
 * Run this ON THE LIVE HOST (the agents' Asana tokens live in the live DB):
 *   cd server
 *   npx tsx scripts/revert-founder-asana.ts <companyId>            # dry-run
 *   npx tsx scripts/revert-founder-asana.ts <companyId> --apply    # delete
 *
 * Pair with the pause switch (PAPERCLIP_FOUNDER_ASANA_PAUSED, default paused) so
 * nothing re-posts after cleanup.
 */
import { createDb, agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { revertFounderAiCommentsForAgent } from "../src/services/agent-asana.js";

const COMPANY = process.argv[2];
const APPLY = process.argv.includes("--apply");
const DB_URL = process.env.DATABASE_URL || process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const CONSOLE_KEYS = ["founderDigest", "principalDigest", "principalDigestZhengXitun"];

async function main() {
  if (!COMPANY) {
    console.error("Usage: npx tsx scripts/revert-founder-asana.ts <companyId> [--apply]");
    process.exit(1);
  }
  const db = createDb(DB_URL);
  const rows = await db.select().from(agents).where(eq(agents.companyId, COMPANY));
  const targets = rows.filter((a) => {
    const md = a.metadata && typeof a.metadata === "object" ? (a.metadata as Record<string, unknown>) : {};
    return CONSOLE_KEYS.some((k) => md[k]);
  });

  console.log(`Mode: ${APPLY ? "APPLY (will delete)" : "DRY-RUN (no changes)"}`);
  console.log(`Company: ${COMPANY}`);
  console.log(`Founder/園長 console agents found: ${targets.length}\n`);

  let totalFound = 0, totalDeleted = 0, totalFailed = 0;
  for (const agent of targets) {
    const report = await revertFounderAiCommentsForAgent(db, COMPANY, agent.id, { apply: APPLY });
    totalFound += report.found;
    totalDeleted += report.deleted;
    totalFailed += report.failed;
    console.log(`▸ ${agent.name} (${agent.id})`);
    console.log(`    scanned ${report.scannedTasks} tasks · AI comments found: ${report.found}` +
      (APPLY ? ` · deleted: ${report.deleted} · failed: ${report.failed}` : ""));
    for (const d of report.details) {
      console.log(`      task ${d.taskGid} → story ${d.storyGid}${APPLY ? (d.deleted ? " ✓ deleted" : " ✗ failed") : " (would delete)"}`);
    }
  }

  console.log(`\nTotal AI comments ${APPLY ? "deleted" : "to delete"}: ${APPLY ? totalDeleted : totalFound}` +
    (APPLY && totalFailed ? ` (${totalFailed} failed — likely a token/ownership issue)` : ""));
  if (!APPLY && totalFound > 0) {
    console.log("Re-run with --apply to delete them.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});
