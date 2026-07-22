import { agents, and, eq, issues, projects, type Db } from "@paperclipai/db";

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
