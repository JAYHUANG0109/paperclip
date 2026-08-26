/**
 * Correct reportsTo lines that drifted from doc/sa-org-chart.md.
 *
 * Applied through agentService.update, the same path the PATCH route uses, so
 * each change lands as a config revision rather than a silent row edit.
 *
 *   tsx scripts/fix-agent-reporting-lines.ts             # dry-run
 *   tsx scripts/fix-agent-reporting-lines.ts --apply
 */
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { agentService } from "../server/src/services/agents.js";

const APPLY = process.argv.includes("--apply");

const YAYA = "2667463a-0b76-486d-ae14-ae7ae769444d"; // 王姿雅 (雅雅)_仁美副園長

const CHANGES = [
  {
    id: "2cc1df11-5abe-417e-89f8-99464e4dd0cb",
    who: "王郁惠_註冊組長 (仁美 · 註冊組)",
    to: YAYA,
    // The chart's line is 組長(L4) → 副園長 → 園長 → 統籌總園長. This one skipped
    // 雅雅 and reported straight to 家秀, alone among 仁美's ten L4 agents — and
    // 雅雅 is the one running 仁美 day to day during 家秀's leave.
    why: "仁美 L4 reports to 副園長 雅雅, not straight to 統籌總園長 家秀",
  },
];

async function main() {
  const config = loadConfig();
  const db = createDb(process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`);
  const svc = agentService(db);

  for (const c of CHANGES) {
    const before = await svc.getById(c.id);
    if (!before) { console.log(`  ! ${c.who}: agent not found`); continue; }
    if (before.reportsTo === c.to) { console.log(`  = ${c.who}: already correct`); continue; }
    console.log(`  ${APPLY ? "·" : "would fix"} ${c.who}\n      ${c.why}\n      reportsTo ${before.reportsTo ?? "(none)"} -> ${c.to}`);
    if (APPLY) await svc.update(c.id, { reportsTo: c.to });
  }
  if (!APPLY) console.log("\npass --apply to write");
  process.exit(0);
}

void main().catch((e) => { console.error(e); process.exit(1); });
