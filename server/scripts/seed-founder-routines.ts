/**
 * Admin one-off: create the "創辦人每日行事曆 — 每日彙整與批閱草擬" Paperclip
 * routine for an agent, with four weekday schedule triggers (Asia/Taipei):
 *   11:30 晨間彙整 · 15:30 午後彙整 · 19:30 傍晚彙整 · 22:00 夜間全量複查
 *
 * Each trigger fires a Paperclip execution issue assigned to the agent; the
 * agent's AGENTS.md "founder daily pipeline" section tells it what to do.
 *
 * Runs through the real routineService (validated cron, correct nextRunAt,
 * revisions) against the local DB — no API/auth tokens involved.
 *
 *   cd server && npx tsx scripts/seed-founder-routines.ts <agentId> [companyId]
 */
import { eq, and } from "drizzle-orm";
import { createDb, routines } from "@paperclipai/db";
import { routineService } from "../src/services/routines.js";

const AGENT = process.argv[2] || "7e1a0853-38f2-4a2f-ac5b-69247c1a350c";
const COMPANY = process.argv[3] || "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const TITLE = "創辦人每日行事曆 — 每日彙整與批閱草擬";

const TRIGGERS = [
  { label: "11:30 晨間彙整", cron: "30 11 * * 1-5" },
  { label: "15:30 午後彙整", cron: "30 15 * * 1-5" },
  { label: "19:30 傍晚彙整", cron: "30 19 * * 1-5" },
  { label: "22:00 夜間全量複查", cron: "0 22 * * 1-5" },
];

const DESCRIPTION = [
  "依 AGENTS.md「創辦人每日行事曆 — 每日彙整與批閱草擬」章節執行。",
  "讀取專案 1211712817475632 的四個區段（🔴急件 / 📅今日會議 / 🟡非急件 / 🔔提醒），",
  "為待批閱項目產出摘要 + 批閱草稿（不送出），為今日會議整理議程與預讀資料，",
  "然後 POST /api/companies/<companyId>/founder-digest 回寫儀表板。",
  "依當下時段填 lastRunLabel。創辦人在儀表板對每個項目做出決定，觸發 founder-review-item",
  "（payload: { taskGid, decision, note }）：decision = approved 核准 / changes_requested",
  "請求變更 / rejected 拒絕；note 為創辦人的留言或建議（選填）。收到後依 decision 在 Asana",
  "貼上 note 評論並套用結果（核准→送出批閱、請求變更→退回並附建議、拒絕→婉拒說明）；",
  "decision 為 null 代表撤回先前決定。",
].join("\n");

async function main() {
  const db = createDb(DB_URL);
  const svc = routineService(db);
  const actor = { agentId: AGENT };

  const existing = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.companyId, COMPANY), eq(routines.title, TITLE), eq(routines.assigneeAgentId, AGENT)));
  if (existing.length > 0) {
    console.log(`Routine already exists (${existing[0].id}); skipping create. Delete it first to re-seed.`);
    process.exit(0);
  }

  const routine = await svc.create(
    COMPANY,
    {
      title: TITLE,
      description: DESCRIPTION,
      assigneeAgentId: AGENT,
      priority: "high",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "enqueue_missed_with_cap",
      variables: [],
      env: null,
    },
    actor,
  );
  console.log("Created routine:", routine.id);

  for (const t of TRIGGERS) {
    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", cronExpression: t.cron, timezone: "Asia/Taipei", label: t.label, enabled: true },
      actor,
    );
    console.log(`  + trigger ${t.label} [${t.cron} Asia/Taipei] nextRunAt=${trigger.nextRunAt?.toISOString?.() ?? trigger.nextRunAt}`);
  }
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message || e);
  process.exit(1);
});
