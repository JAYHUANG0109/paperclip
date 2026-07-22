/**
 * Onboarding-game seeder (Phase 1) — create the 「🎓 上手教學」 project + 5 sequential
 * 關卡 (blocker-chained issues) for one agent, and mark agent.metadata.onboarding.
 *
 * The 關卡 issues are the source of truth for progress; 關卡 k+1 is `blocked_by`
 * 關卡 k (issue_relations type=blocks: k blocks k+1) so only the current one is
 * actionable. The agent teaches each level via interactive cards (Phase 2). The
 * lesson brief lives in each issue's description.
 *
 * SAFE: dry-run by default; --apply to write. Idempotent — skips if this agent
 * already has onboarding seeded (agent.metadata.onboarding present, unless --reseed).
 * Reversible: archive the 教學 project + null agent.metadata.onboarding.
 *
 * Usage:
 *   tsx scripts/seed-onboarding-game.ts --agent <agentId>            # dry-run
 *   tsx scripts/seed-onboarding-game.ts --agent <agentId> --apply
 */
import { agents, and, createDb, eq, issueRelations, issues, projects } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

const APPLY = process.argv.includes("--apply");
const RESEED = process.argv.includes("--reseed");
function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const PROJECT_NAME = "🎓 上手教學｜Onboarding";
const KANS = [
  { key: "setup", title: "關卡 1｜設定與連線", desc: "教學（互動卡片）：到「我的助理 / My Agent」→ 連線，貼上你自己的 Asana 個人存取權杖（Personal Access Token）。完成條件（真實訊號）：Asana 連線一存好，系統自動判定過關。" },
  { key: "first-task", title: "關卡 2｜建立你的第一個任務", desc: "教學：到「我的助理 / My Agent」頁 → 新增任務 → 指派給你的 agent → 寫清楚驗收（例：整理 Asana 上某專案的任務清單）。完成條件（真實訊號）：真的建立了一個你自己開的任務（非教學關卡）。" },
  { key: "collaborate", title: "關卡 3｜與 agent 協作", desc: "教學：agent 常需要你拍板。用「卡片內建的文字框」直接回一句話並按『完成本關』。完成條件（真實訊號）：你在卡片裡送出了一段非空回覆。" },
  { key: "dashboard", title: "關卡 4｜儀表板與收件匣", desc: "教學：到「儀表板 / Dashboard」找「待我處理 / Needs you」，開啟一個項目。完成條件：找到並開啟一個項目後回來確認。" },
  { key: "skills-routines", title: "關卡 5｜技能與例行作業", desc: "教學：技能（Skills）依情境自動觸發；例行作業（Routines）是排定的固定行程。完成條件：看過一個技能或一個 routine 後回來確認。" },
] as const;

async function main() {
  const agentId = flag("--agent");
  if (!agentId) { console.error("--agent <agentId> is required."); process.exit(1); }

  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim() || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const agent = (await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, metadata: agents.metadata })
    .from(agents).where(eq(agents.id, agentId)))[0];
  if (!agent) { console.error(`Agent ${agentId} not found.`); process.exit(1); }

  const md = (agent.metadata ?? {}) as Record<string, unknown>;
  if (md.onboarding && !RESEED) {
    console.log(`Agent ${agent.name} already has onboarding seeded (metadata.onboarding present). Use --reseed to force.`);
    process.exit(0);
  }

  console.log(`${APPLY ? "APPLYING" : "DRY-RUN"} onboarding seed for agent ${agent.name} (${agent.id}), company ${agent.companyId}\n`);
  console.log(`project: "${PROJECT_NAME}"`);
  console.log(`關卡 (5), blocker-chained k→k+1:`);
  for (const k of KANS) console.log(`  - [${k.key}] ${k.title}`);

  if (!APPLY) {
    console.log(`\nWould create: 1 project (if absent), 5 關卡 issues, 4 blocker relations, and set metadata.onboarding {stage:1,total:5,status:"in_progress"}.`);
    console.log("Re-run with --apply to write.");
    await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
    return;
  }

  // find-or-create the company onboarding project
  let project = (await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.companyId, agent.companyId), eq(projects.name, PROJECT_NAME))))[0];
  if (!project) {
    project = (await db.insert(projects).values({ companyId: agent.companyId, name: PROJECT_NAME }).returning({ id: projects.id }))[0]!;
    console.log(`created project ${project.id}`);
  } else {
    console.log(`reusing project ${project.id}`);
  }

  // create the 5 關卡 issues (originKind/originId tag them as onboarding for this agent)
  const created: { key: string; id: string }[] = [];
  for (const k of KANS) {
    const row = (await db.insert(issues).values({
      companyId: agent.companyId,
      projectId: project.id,
      title: k.title,
      description: k.desc,
      status: "backlog",
      assigneeAgentId: agent.id,
      originKind: "onboarding",
      originId: `onboarding:${agent.id}:${k.key}`,
    }).returning({ id: issues.id }))[0]!;
    created.push({ key: k.key, id: row.id });
  }
  console.log(`created ${created.length} 關卡 issues`);

  // chain blockers: 關卡 k blocks 關卡 k+1
  for (let i = 0; i < created.length - 1; i++) {
    await db.insert(issueRelations).values({
      companyId: agent.companyId,
      issueId: created[i]!.id,
      relatedIssueId: created[i + 1]!.id,
      type: "blocks",
    });
  }
  console.log(`created ${created.length - 1} blocker relations (sequential unlock)`);

  // mark onboarding state
  const onboarding = {
    stage: 1,
    total: KANS.length,
    completedKeys: [] as string[],
    status: "in_progress",
    projectId: project.id,
    issues: Object.fromEntries(created.map((c) => [c.key, c.id])),
    startedAt: new Date().toISOString(),
  };
  await db.update(agents).set({ metadata: { ...md, onboarding }, updatedAt: new Date() }).where(eq(agents.id, agent.id));
  console.log(`set agent.metadata.onboarding (stage 1/${KANS.length})`);
  console.log(`\nApplied. 關卡 1 is actionable; 2-5 are blocked until the prior completes.`);
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}

void main().then(() => process.exit(0)).catch((e) => {
  console.error(`onboarding seed failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
