/**
 * Admin one-off: create a daily-console Paperclip routine for an agent, with
 * one weekday schedule trigger (Asia/Taipei):
 *   12:00 中午彙整
 *
 * Two variants share the same 4-block dashboard + directive contract; they only
 * differ in which Asana project the agent reads (see each agent's AGENTS.md):
 *   founder   — 創辦人每日行事曆 (唐富美)
 *   principal — 仁美｜園長待決議與提醒 (吳家秀 / 王姿雅)
 *
 * Each trigger fires a Paperclip execution issue assigned to the agent; the
 * agent's AGENTS.md "daily pipeline" section tells it what to do. Runs through
 * the real routineService (validated cron, nextRunAt, revisions); idempotent.
 *
 *   cd server && npx tsx scripts/seed-founder-routines.ts <agentId> [companyId] [founder|principal]
 */
import { eq, and } from "drizzle-orm";
import { createDb, routines } from "@paperclipai/db";
import { routineService } from "../src/services/routines.js";

const AGENT = process.argv[2] || "7e1a0853-38f2-4a2f-ac5b-69247c1a350c";
const COMPANY = process.argv[3] || "0980d089-ebdf-4f54-9576-1a9150c5d6f9";
const VARIANT = (process.argv[4] || "founder") as "founder" | "principal" | "principalZhengXitun";
const DB_URL = process.env.SEED_DB_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

const TRIGGERS = [
  { label: "12:00 中午彙整", cron: "0 12 * * 1-5" },
];

// Shared tail describing the founder-review-item / founder-close-item contract.
const DIRECTIVE_TAIL = [
  "依當下時段填 lastRunLabel。儀表板裁示鈕觸發 founder-review-item（payload: { taskGid,",
  "decision, note }）：decision = approved 核准 / changes_requested 請求變更 / rejected 拒絕",
  "（null＝撤回）；收到後先把 note 貼為 Asana 評論，再依 decision 套用結果。會議／提醒項的",
  "「結案」鈕觸發 founder-close-item（payload: { taskGid, closed }）：closed=true → complete-task。",
].join("\n");

const CONFIGS: Record<"founder" | "principal" | "principalZhengXitun", { title: string; description: string }> = {
  founder: {
    title: "創辦人每日行事曆 — 每日彙整與批閱草擬",
    description: [
      "依 AGENTS.md「創辦人每日行事曆 — 每日彙整與批閱草擬」章節執行。",
      "讀取專案 1211712817475632 的四個區段（🔴急件 / 📅今日會議 / 🟡非急件 / 🔔提醒），",
      "為待批閱項目產出摘要 + 批閱草稿（不送出），為今日會議整理議程與預讀資料，",
      "然後 POST /api/companies/<companyId>/founder-digest 回寫儀表板。",
      DIRECTIVE_TAIL,
    ].join("\n"),
  },
  principal: {
    title: "仁美園長每日待決議與提醒 — 每日彙整與裁示草擬",
    description: [
      "依 AGENTS.md「仁美園長每日待決議與提醒 — 每日彙整與裁示草擬」章節執行。",
      "用園長本人的 token 解析 Asana 專案「仁美｜園長待決議與提醒（Renmei Pending Decisions",
      "& Reminders）」的 GID 與 sections，對應到四類（urgent / meetings / nonUrgent / reminders），",
      "為待決議項產出摘要 + 裁示草稿（不送出），為今日會議整理議程與預讀資料，",
      "然後 POST /api/companies/<companyId>/founder-digest 回寫儀表板（與創辦人相同四宮格）。",
      DIRECTIVE_TAIL,
    ].join("\n"),
  },
  principalZhengXitun: {
    title: "市政・西屯園長待決議與提醒 — 每日彙整與裁示草擬",
    description: [
      "依 AGENTS.md「市政・西屯園長待決議與提醒 — 每日彙整與裁示草擬」章節執行。",
      "用本人 token 解析兩個 Asana 專案「市政｜園長待決議與提醒（ShiZheng Pending Decisions",
      "& Reminders）」與「西屯｜園長待決議與提醒（Xitun Pending Decisions & Reminders）」的 GID",
      "與 sections，**把兩校合併**對應到四類（urgent / meetings / nonUrgent / reminders），每筆 name",
      "前加校別標記〔市政〕／〔西屯〕，為待決議項產出摘要 + 裁示草稿（不送出），",
      "然後 POST /api/companies/<companyId>/founder-digest 回寫，**body 務必帶 \"console\": \"principalZhengXitun\"**。",
      DIRECTIVE_TAIL,
    ].join("\n"),
  },
};

const { title: TITLE, description: DESCRIPTION } = CONFIGS[VARIANT];

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
