import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companySkills,
  heartbeatRuns,
  issues,
  skillUsageEvents,
} from "@paperclipai/db";
import { levelForXp, titleForLevel, xpToReachLevel } from "./office-progression.js";

/**
 * Agent progression — the Virtual Office gamification layer for AGENTS (the
 * office floor shows agents, not users, so this is the agent-facing sibling of
 * {@link ./office-progression.ts}, which scores human skill authors).
 *
 * Everything here is computed on read from data the platform already persists:
 *   - issues            → tasks completed, delivered-before-due, quick pickup,
 *                          delegation (created-for-someone-else)
 *   - approvals         → reviews approved / revisions requested (quality)
 *   - skill_usage_events→ minutes saved + skills/domains actually exercised
 *   - heartbeat_runs    → active-day history → streaks / reliable weeks
 *   - agents.reportsTo  → sub-agents overseen (mentorship)
 *
 * Levels reuse the exact same curve + rank titles as the user ladder so the two
 * progressions feel like one game. XP = minutes-saved + task volume + one-time
 * badge bonuses.
 */

const XP_PER_TASK = 20;

export interface AgentBadgeMetrics {
  tasksCompleted: number;
  highPriorityDone: number;
  aheadOfTime: number;
  rapidResponse: number;
  reviewsApproved: number;
  revisionsRequested: number;
  minutesSaved: number;
  distinctSkillsUsed: number;
  distinctProjects: number;
  streakDays: number;
  reliableWeeks: number;
  subReportsCompleted: number;
  handoffs: number;
}

export function emptyMetrics(): AgentBadgeMetrics {
  return {
    tasksCompleted: 0,
    highPriorityDone: 0,
    aheadOfTime: 0,
    rapidResponse: 0,
    reviewsApproved: 0,
    revisionsRequested: 0,
    minutesSaved: 0,
    distinctSkillsUsed: 0,
    distinctProjects: 0,
    streakDays: 0,
    reliableWeeks: 0,
    subReportsCompleted: 0,
    handoffs: 0,
  };
}

interface AgentBadgeDef {
  key: string;
  emoji: string;
  zh: string;
  en: string;
  /** One-time XP granted the first time the badge is earned. */
  xp: number;
  /** Threshold the metric must reach. */
  target: number;
  /** Current value of this badge's metric for an agent (also drives the progress bar). */
  value: (m: AgentBadgeMetrics) => number;
}

/**
 * The 15 badges (no animals). Ordered as they appear on the shelf. Flawless /
 * One-Shot fold their "zero revisions" gate into value() so a single revision
 * request drops progress back to 0 — the record has to stay clean.
 */
export const AGENT_BADGES: AgentBadgeDef[] = [
  { key: "first_assignment", emoji: "🎯", zh: "初次任務", en: "First Assignment", xp: 100, target: 1, value: (m) => m.tasksCompleted },
  { key: "centurion", emoji: "💯", zh: "百戰達成", en: "Centurion", xp: 600, target: 100, value: (m) => m.tasksCompleted },
  { key: "time_saver", emoji: "⏱️", zh: "省時新星", en: "Time Saver", xp: 300, target: 1000, value: (m) => m.minutesSaved },
  { key: "time_architect", emoji: "🏛️", zh: "時間建築師", en: "Time Architect", xp: 800, target: 10000, value: (m) => m.minutesSaved },
  { key: "toolsmith", emoji: "🛠️", zh: "技能工匠", en: "Toolsmith", xp: 300, target: 10, value: (m) => m.distinctSkillsUsed },
  { key: "priority_closer", emoji: "🚨", zh: "重案剋星", en: "Priority Closer", xp: 400, target: 15, value: (m) => m.highPriorityDone },
  { key: "flawless", emoji: "💎", zh: "零瑕紀錄", en: "Flawless Record", xp: 500, target: 20, value: (m) => (m.revisionsRequested === 0 ? m.tasksCompleted : 0) },
  { key: "one_shot", emoji: "🥇", zh: "一次到位", en: "One-Shot", xp: 400, target: 10, value: (m) => (m.revisionsRequested === 0 ? m.reviewsApproved : 0) },
  { key: "ahead_of_time", emoji: "🚀", zh: "超前交付", en: "Ahead of Time", xp: 400, target: 15, value: (m) => m.aheadOfTime },
  { key: "rapid_response", emoji: "⚡", zh: "神速回應", en: "Rapid Response", xp: 300, target: 10, value: (m) => m.rapidResponse },
  { key: "polymath", emoji: "🧠", zh: "全能通才", en: "Polymath", xp: 400, target: 3, value: (m) => m.distinctProjects },
  { key: "reliable", emoji: "🛡️", zh: "全勤穩定", en: "Reliable", xp: 500, target: 4, value: (m) => m.reliableWeeks },
  { key: "on_a_roll", emoji: "🔥", zh: "連勝氣勢", en: "On a Roll", xp: 500, target: 30, value: (m) => m.streakDays },
  { key: "collaborator", emoji: "🤝", zh: "協作夥伴", en: "Collaborator", xp: 350, target: 25, value: (m) => m.handoffs },
  { key: "mentor", emoji: "🧭", zh: "領路人", en: "Mentor", xp: 500, target: 20, value: (m) => m.subReportsCompleted },
];

export interface AgentBadgeState {
  key: string;
  emoji: string;
  zh: string;
  en: string;
  xp: number;
  earned: boolean;
  /** Progress toward the threshold, capped at target (for the ring/bar). */
  current: number;
  target: number;
}

export interface AgentProgression {
  totalXp: number;
  level: number;
  title: { zh: string; en: string };
  xpToNext: number;
  levelFloorXp: number;
  nextLevelXp: number;
  earnedCount: number;
  badges: AgentBadgeState[];
}

/** Compute the full progression for one agent's metrics. Pure — unit-testable. */
export function agentProgressionFor(m: AgentBadgeMetrics): AgentProgression {
  const badges: AgentBadgeState[] = AGENT_BADGES.map((b) => {
    const v = Math.max(0, Math.floor(b.value(m)));
    return {
      key: b.key,
      emoji: b.emoji,
      zh: b.zh,
      en: b.en,
      xp: b.xp,
      earned: v >= b.target,
      current: Math.min(v, b.target),
      target: b.target,
    };
  });
  const milestone = badges.reduce((sum, b) => (b.earned ? sum + b.xp : sum), 0);
  const base = Math.round(m.minutesSaved) + m.tasksCompleted * XP_PER_TASK;
  const totalXp = Math.max(0, base + milestone);
  const level = levelForXp(totalXp);
  const levelFloorXp = xpToReachLevel(level);
  const nextLevelXp = xpToReachLevel(level + 1);
  return {
    totalXp,
    level,
    title: titleForLevel(level),
    xpToNext: Math.max(0, nextLevelXp - totalXp),
    levelFloorXp,
    nextLevelXp,
    earnedCount: badges.filter((b) => b.earned).length,
    badges,
  };
}

const DAY_MS = 86_400_000;

/**
 * Longest consecutive-calendar-day streak, and the longest run of consecutive
 * fully-covered work weeks (Mon–Fri each present), from a list of 'YYYY-MM-DD'
 * active days. Pure — unit-testable.
 */
export function computeStreaks(days: string[]): { streakDays: number; reliableWeeks: number } {
  const epochs = Array.from(new Set(days))
    .map((d) => Date.parse(`${d}T00:00:00Z`))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (epochs.length === 0) return { streakDays: 0, reliableWeeks: 0 };

  let run = 1;
  let bestDays = 1;
  for (let i = 1; i < epochs.length; i++) {
    if (epochs[i]! - epochs[i - 1]! === DAY_MS) {
      run += 1;
      bestDays = Math.max(bestDays, run);
    } else {
      run = 1;
    }
  }

  // Bucket weekdays by the Monday that starts their week.
  const weekdaysByMonday = new Map<number, Set<number>>();
  for (const e of epochs) {
    const dow = new Date(e).getUTCDay(); // 0=Sun … 6=Sat
    if (dow === 0 || dow === 6) continue; // weekends don't count toward a work week
    const monday = e - (dow - 1) * DAY_MS;
    const set = weekdaysByMonday.get(monday) ?? new Set<number>();
    set.add(dow);
    weekdaysByMonday.set(monday, set);
  }
  const completeMondays = [...weekdaysByMonday.entries()]
    .filter(([, set]) => [1, 2, 3, 4, 5].every((w) => set.has(w)))
    .map(([m]) => m)
    .sort((a, b) => a - b);
  let wkRun = completeMondays.length > 0 ? 1 : 0;
  let bestWeeks = wkRun;
  for (let i = 1; i < completeMondays.length; i++) {
    if (completeMondays[i]! - completeMondays[i - 1]! === 7 * DAY_MS) {
      wkRun += 1;
      bestWeeks = Math.max(bestWeeks, wkRun);
    } else {
      wkRun = 1;
    }
  }
  return { streakDays: bestDays, reliableWeeks: bestWeeks };
}

export function agentProgressionService(db: Db) {
  /** Compute progression for every agent in a company. Keyed by agentId. */
  async function computeForCompany(companyId: string): Promise<Record<string, AgentProgression>> {
    const metrics = new Map<string, AgentBadgeMetrics>();
    const ensure = (agentId: string | null | undefined): AgentBadgeMetrics | null => {
      if (!agentId) return null;
      let m = metrics.get(agentId);
      if (!m) {
        m = emptyMetrics();
        metrics.set(agentId, m);
      }
      return m;
    };

    const [agentRows, issueAgg, delegRows, apprRows, usageRows, runDayRows] = await Promise.all([
      db
        .select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
      db
        .select({
          agentId: issues.assigneeAgentId,
          done: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
          hiDone: sql<number>`count(*) filter (where ${issues.status} = 'done' and ${issues.priority} in ('high', 'urgent'))::int`,
          projects: sql<number>`count(distinct ${issues.projectId}) filter (where ${issues.status} = 'done' and ${issues.projectId} is not null)::int`,
          ahead: sql<number>`count(*) filter (where ${issues.status} = 'done' and ${issues.dueDate} is not null and ${issues.completedAt} is not null and ${issues.completedAt}::date < ${issues.dueDate})::int`,
          rapid: sql<number>`count(*) filter (where ${issues.startedAt} is not null and ${issues.startedAt} <= ${issues.createdAt} + interval '15 minutes')::int`,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.assigneeAgentId),
      db
        .select({
          agentId: issues.createdByAgentId,
          handoffs: sql<number>`count(*) filter (where ${issues.assigneeAgentId} is not null and ${issues.assigneeAgentId} <> ${issues.createdByAgentId})::int`,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.createdByAgentId),
      db
        .select({
          agentId: approvals.requestedByAgentId,
          approved: sql<number>`count(*) filter (where ${approvals.status} = 'approved')::int`,
          revisions: sql<number>`count(*) filter (where ${approvals.status} in ('revision_requested', 'rejected'))::int`,
        })
        .from(approvals)
        .where(eq(approvals.companyId, companyId))
        .groupBy(approvals.requestedByAgentId),
      db
        .select({
          agentId: skillUsageEvents.usedByAgentId,
          minutes: sql<number>`coalesce(sum(${skillUsageEvents.invocations} * ${companySkills.minutesPerUse}), 0)::int`,
          distinctSkills: sql<number>`count(distinct ${skillUsageEvents.skillId})::int`,
        })
        .from(skillUsageEvents)
        .innerJoin(companySkills, eq(skillUsageEvents.skillId, companySkills.id))
        .where(eq(skillUsageEvents.companyId, companyId))
        .groupBy(skillUsageEvents.usedByAgentId),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          day: sql<string>`to_char(date_trunc('day', ${heartbeatRuns.startedAt}), 'YYYY-MM-DD')`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "succeeded"), isNotNull(heartbeatRuns.startedAt)))
        .groupBy(heartbeatRuns.agentId, sql`date_trunc('day', ${heartbeatRuns.startedAt})`),
    ]);

    // Seed every non-terminated agent so idle agents still get a (Level 1) card.
    const doneByAgent = new Map<string, number>();
    for (const a of agentRows) {
      if (a.status !== "terminated") ensure(a.id);
    }

    for (const r of issueAgg) {
      const m = ensure(r.agentId);
      doneByAgent.set(r.agentId ?? "", Number(r.done) || 0);
      if (!m) continue;
      m.tasksCompleted = Number(r.done) || 0;
      m.highPriorityDone = Number(r.hiDone) || 0;
      m.distinctProjects = Number(r.projects) || 0;
      m.aheadOfTime = Number(r.ahead) || 0;
      m.rapidResponse = Number(r.rapid) || 0;
    }
    for (const r of delegRows) {
      const m = ensure(r.agentId);
      if (m) m.handoffs = Number(r.handoffs) || 0;
    }
    for (const r of apprRows) {
      const m = ensure(r.agentId);
      if (!m) continue;
      m.reviewsApproved = Number(r.approved) || 0;
      m.revisionsRequested = Number(r.revisions) || 0;
    }
    for (const r of usageRows) {
      const m = ensure(r.agentId);
      if (!m) continue;
      m.minutesSaved = Number(r.minutes) || 0;
      m.distinctSkillsUsed = Number(r.distinctSkills) || 0;
    }


    // Streaks from active-day history.
    const daysByAgent = new Map<string, string[]>();
    for (const r of runDayRows) {
      if (!r.agentId || !r.day) continue;
      const list = daysByAgent.get(r.agentId) ?? [];
      list.push(r.day);
      daysByAgent.set(r.agentId, list);
    }
    for (const [agentId, days] of daysByAgent) {
      const m = ensure(agentId);
      if (!m) continue;
      const { streakDays, reliableWeeks } = computeStreaks(days);
      m.streakDays = streakDays;
      m.reliableWeeks = reliableWeeks;
    }

    // Mentorship: sum of completed tasks by an agent's direct reports.
    for (const a of agentRows) {
      if (!a.reportsTo) continue;
      const manager = ensure(a.reportsTo);
      if (manager) manager.subReportsCompleted += doneByAgent.get(a.id) ?? 0;
    }

    const out: Record<string, AgentProgression> = {};
    for (const [agentId, m] of metrics) {
      out[agentId] = agentProgressionFor(m);
    }
    return out;
  }

  return { computeForCompany };
}
