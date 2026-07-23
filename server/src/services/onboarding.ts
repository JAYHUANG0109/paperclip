import {
  agentMemberships,
  agents,
  and,
  authUsers,
  companySkills,
  eq,
  issueRelations,
  issues,
  projectAccessMembers,
  projects,
  type Db,
} from "@paperclipai/db";

/**
 * Onboarding-game (關卡) state, mirrored on `agents.metadata.onboarding`. The
 * 關卡 issues are the source of truth for progress; this mirror powers the
 * progress badge and lets server-side signals advance a level.
 */
export interface OnboardingState {
  stage: number;
  total: number;
  completedKeys: string[];
  status: "in_progress" | "done";
  projectId?: string | null;
  issues?: Record<string, string>;
  startedAt?: string;
  completedAt?: string | null;
}

function readOnboarding(metadata: unknown): OnboardingState | null {
  if (!metadata || typeof metadata !== "object") return null;
  const ob = (metadata as Record<string, unknown>).onboarding;
  if (!ob || typeof ob !== "object") return null;
  const s = ob as Record<string, unknown>;
  if (typeof s.total !== "number" || !Array.isArray(s.completedKeys)) return null;
  return {
    stage: typeof s.stage === "number" ? s.stage : 1,
    total: s.total,
    completedKeys: (s.completedKeys as unknown[]).filter((k): k is string => typeof k === "string"),
    status: s.status === "done" ? "done" : "in_progress",
    projectId: typeof s.projectId === "string" ? s.projectId : null,
    issues: s.issues && typeof s.issues === "object"
      ? (s.issues as Record<string, string>)
      : undefined,
    startedAt: typeof s.startedAt === "string" ? s.startedAt : undefined,
    completedAt: typeof s.completedAt === "string" ? s.completedAt : null,
  };
}

/**
 * Mark one onboarding 關卡 (identified by its key, e.g. "setup", "first-task")
 * complete from a *real* server-side signal — connection verified, first task
 * created, etc. Idempotent: a no-op if the key is already done or onboarding is
 * finished, so it is safe to call on every relevant event and safe to race with
 * the agent-driven "完成本關" path.
 *
 * Effects: sets the 關卡 issue to `done` (which resolves its blocker so the next
 * 關卡 unlocks), advances `stage`, appends the key to `completedKeys`. When all
 * keys are complete it marks `status:"done"` and archives the 教學 project.
 *
 * Best-effort by design — callers should wrap in try/catch so a failure here
 * never breaks the primary action (token storage, task creation, …). Returns
 * whether it advanced anything.
 */
export async function advanceOnboarding(
  db: Db,
  input: { agentId: string; key: string },
): Promise<{ advanced: boolean; completed?: boolean }> {
  const { agentId, key } = input;
  const agent = (await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, agentId)))[0];
  if (!agent) return { advanced: false };

  const state = readOnboarding(agent.metadata);
  if (!state) return { advanced: false };
  if (state.status === "done") return { advanced: false };
  if (state.completedKeys.includes(key)) return { advanced: false };

  // Mark the 關卡 issue done (unblocks the next level).
  const issueId = state.issues?.[key];
  if (issueId) {
    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)));
  }

  const completedKeys = [...state.completedKeys, key];
  const allDone = completedKeys.length >= state.total;
  const nextState: OnboardingState = {
    ...state,
    completedKeys,
    stage: Math.min(state.total, completedKeys.length + 1),
    status: allDone ? "done" : "in_progress",
    completedAt: allDone ? new Date().toISOString() : state.completedAt ?? null,
  };

  const md = (agent.metadata && typeof agent.metadata === "object")
    ? (agent.metadata as Record<string, unknown>)
    : {};
  await db
    .update(agents)
    .set({ metadata: { ...md, onboarding: nextState }, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  // Archive the 教學 project once every 關卡 is done.
  if (allDone && state.projectId) {
    await db
      .update(projects)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projects.id, state.projectId), eq(projects.companyId, agent.companyId)));
  }

  return { advanced: true, completed: allDone };
}

export const ONBOARDING_PROJECT_NAME = "🎓 上手教學｜Onboarding";
export const ONBOARDING_SKILL_SLUG = "onboarding-game-guide";

// The 5 關卡 (single source of truth — the seed script imports these). Titles/
// descriptions mirror the onboarding-game-guide skill's cards.
export const ONBOARDING_KANS = [
  { key: "setup", title: "關卡 1｜設定與連線", desc: "教學（互動卡片）：到「我的助理 / My Agent」→ 連線，貼上你自己的 Asana 個人存取權杖（Personal Access Token）。完成條件（真實訊號）：Asana 連線一存好，系統自動判定過關。" },
  { key: "first-task", title: "關卡 2｜建立你的第一個任務", desc: "教學：到「我的助理 / My Agent」頁 → 新增任務 → 指派給你的 agent → 寫清楚驗收（例：整理 Asana 上某專案的任務清單）。完成條件（真實訊號）：真的建立了一個你自己開的任務（非教學關卡）。" },
  { key: "collaborate", title: "關卡 3｜與 agent 協作", desc: "教學：agent 常需要你拍板。用「卡片內建的文字框」直接回一句話並按『完成本關』。完成條件（真實訊號）：你在卡片裡送出了一段非空回覆。" },
  { key: "dashboard", title: "關卡 4｜儀表板：我的任務・我的行程・待決議", desc: "教學：到「儀表板 / Dashboard」看「我的任務（Asana）」與「我的行程」；在『我的行程』設定填入你的名字比對（中文全名/英文名/暱稱，逗號分隔）並儲存，讓 Google 日曆活動正確載入；需要你拍板的事都在左側「待決議」。完成條件：走過儀表板三塊、存好名字比對、並在待決議處理一項。" },
  { key: "skills-routines", title: "關卡 5｜做一支你的技能", desc: "教學：技能（Skills）＝會依情境自動觸發的招式。兩條路都行——(A) 自己到「技能」按「＋ 新增」上傳 SKILL.md（或 GitHub／範本），選存取範圍（公開／團隊〔校區×部門〕／私人）；或 (B) 直接請你的 agent 幫你做（描述需求或貼一段 SOP），由 agent 生成並確認存取範圍。完成條件：真的有一支你的技能被建立（自己傳或 agent 幫你做都算）。" },
] as const;

export interface SeedOnboardingResult {
  seeded: boolean;
  reason?: "already" | "built-in" | "system" | "no-owner" | "not-found";
  projectId?: string;
}

/**
 * Provision the onboarding game for ONE agent, idempotently. Creates a PRIVATE
 * per-agent 「🎓 上手教學」 project (owned by the agent's user), 5 blocker-chained
 * 關卡 issues, the `metadata.onboarding` mirror, and equips the onboarding-game
 * skill so the agent knows how to run the 關卡. Best-effort — callers wrap so it
 * never breaks agent creation. Skips built-in / system-automation / owner-less
 * agents (nobody to onboard) and agents already seeded.
 */
export async function seedOnboardingForAgent(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<SeedOnboardingResult> {
  const { companyId, agentId } = input;
  const agent = (await db
    .select({ id: agents.id, companyId: agents.companyId, metadata: agents.metadata, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId)))[0];
  if (!agent || agent.companyId !== companyId) return { seeded: false, reason: "not-found" };

  const md = (agent.metadata && typeof agent.metadata === "object") ? { ...(agent.metadata as Record<string, unknown>) } : {};
  if (md.onboarding) return { seeded: false, reason: "already" };
  if (md.paperclipBuiltInAgent === true) return { seeded: false, reason: "built-in" };
  const teams = Array.isArray(md.teams) ? (md.teams as unknown[]).filter((t): t is string => typeof t === "string") : [];
  if (teams.includes("系統自動化")) return { seeded: false, reason: "system" };

  // Resolve the owner user: a joined membership first, else any membership, else
  // the agent's assignedUserEmail (covers a just-created agent whose user hasn't
  // joined yet but already has an account/invite).
  const memberships = await db
    .select({ userId: agentMemberships.userId, state: agentMemberships.state })
    .from(agentMemberships)
    .where(and(eq(agentMemberships.companyId, companyId), eq(agentMemberships.agentId, agentId)));
  let ownerUserId: string | null =
    memberships.find((m) => m.state === "joined")?.userId ?? memberships[0]?.userId ?? null;
  if (!ownerUserId) {
    const cfg = (agent.adapterConfig && typeof agent.adapterConfig === "object") ? (agent.adapterConfig as { assignedUserEmail?: string }) : {};
    const email = cfg.assignedUserEmail?.trim().toLowerCase();
    if (email) {
      const u = (await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)))[0];
      ownerUserId = u?.id ?? null;
    }
  }
  if (!ownerUserId) return { seeded: false, reason: "no-owner" };

  // Private per-agent project, owned by that user; the user (admin) + the agent
  // (editor) are the only members, so onboarding stays isolated per user.
  const project = (await db
    .insert(projects)
    .values({ companyId, name: ONBOARDING_PROJECT_NAME, visibility: "private", ownerUserId })
    .returning({ id: projects.id }))[0]!;
  await db.insert(projectAccessMembers).values([
    { companyId, projectId: project.id, principalType: "user", principalId: ownerUserId, projectRole: "admin" },
    { companyId, projectId: project.id, principalType: "agent", principalId: agentId, projectRole: "editor" },
  ]);

  const created: { key: string; id: string }[] = [];
  for (const k of ONBOARDING_KANS) {
    const row = (await db
      .insert(issues)
      .values({
        companyId,
        projectId: project.id,
        title: k.title,
        description: k.desc,
        status: "backlog",
        assigneeAgentId: agentId,
        originKind: "onboarding",
        originId: `onboarding:${agentId}:${k.key}`,
      })
      .returning({ id: issues.id }))[0]!;
    created.push({ key: k.key, id: row.id });
  }
  for (let i = 0; i < created.length - 1; i++) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: created[i]!.id,
      relatedIssueId: created[i + 1]!.id,
      type: "blocks",
    });
  }

  // Equip the onboarding-game skill (it lives in a restricted folder so new
  // agents don't auto-get it) by adding its key to desiredSkills.
  const adapterConfig = (agent.adapterConfig && typeof agent.adapterConfig === "object")
    ? { ...(agent.adapterConfig as Record<string, unknown>) }
    : {};
  const skill = (await db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), eq(companySkills.slug, ONBOARDING_SKILL_SLUG))))[0];
  if (skill?.key) {
    const sync = (adapterConfig.paperclipSkillSync && typeof adapterConfig.paperclipSkillSync === "object")
      ? { ...(adapterConfig.paperclipSkillSync as Record<string, unknown>) }
      : {};
    const desired = Array.isArray(sync.desiredSkills) ? [...(sync.desiredSkills as unknown[])] : [];
    const already = desired.some((d) => d === skill.key || (d && typeof d === "object" && (d as { key?: string }).key === skill.key));
    if (!already) desired.push(skill.key);
    sync.desiredSkills = desired;
    adapterConfig.paperclipSkillSync = sync;
  }

  const onboarding: OnboardingState = {
    stage: 1,
    total: ONBOARDING_KANS.length,
    completedKeys: [],
    status: "in_progress",
    projectId: project.id,
    issues: Object.fromEntries(created.map((c) => [c.key, c.id])),
    startedAt: new Date().toISOString(),
  };
  await db
    .update(agents)
    .set({ metadata: { ...md, onboarding }, adapterConfig, updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  return { seeded: true, projectId: project.id };
}
