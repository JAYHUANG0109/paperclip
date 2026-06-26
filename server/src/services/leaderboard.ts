import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, companySkillUsage } from "@paperclipai/db";

// Scoring (mirrors the intended formula):
//   score = minutesSaved × teamBonus × bountyBonus
//   minutesSaved = Σ over the trainer's APPROVED skills (minutesPerUse × usageCount)
//   teamBonus    = 2.0 if a skill was used by ≥3 distinct people, else 1.0 (per-skill, applied to that skill's minutes)
//   bountyBonus  = 1.0 for now (activates with the bounty board, Phase 10C)
const TEAM_BONUS_THRESHOLD = 3;
const TEAM_BONUS = 2.0;

export interface LeaderboardEntry {
  userId: string;
  minutesSaved: number; // already weighted by team bonus
  rawMinutes: number;
  runCount: number;
  skillCount: number;
  beneficiaries: number; // distinct people who used this trainer's skills
  bountyCount: number;
  score: number;
}

export interface LeaderboardResult {
  period: string; // 'YYYY-MM' for monthly, 'lifetime' otherwise
  entries: LeaderboardEntry[];
}

export function leaderboardService(db: Db) {
  // Aggregate per-skill usage for a company, optionally scoped to a month.
  async function skillUsageRows(companyId: string, periodMonth: string | null) {
    const where = periodMonth
      ? and(eq(companySkillUsage.companyId, companyId), eq(companySkillUsage.periodMonth, periodMonth))
      : eq(companySkillUsage.companyId, companyId);
    return db
      .select({
        skillId: companySkillUsage.skillId,
        totalCount: sql<number>`coalesce(sum(${companySkillUsage.count}), 0)::int`,
        distinctUsers: sql<number>`count(distinct ${companySkillUsage.usedByUserId})::int`,
      })
      .from(companySkillUsage)
      .where(where)
      .groupBy(companySkillUsage.skillId);
  }

  async function compute(companyId: string, periodMonth: string | null): Promise<LeaderboardResult> {
    const [skills, usage] = await Promise.all([
      db
        .select({
          id: companySkills.id,
          createdByUserId: companySkills.createdByUserId,
          minutesPerUse: companySkills.minutesPerUse,
          approvalStatus: companySkills.approvalStatus,
        })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId)),
      skillUsageRows(companyId, periodMonth),
    ]);

    const usageBySkill = new Map(usage.map((u) => [u.skillId, u]));
    const byUser = new Map<string, LeaderboardEntry>();

    for (const skill of skills) {
      if (!skill.createdByUserId) continue;
      if (skill.approvalStatus !== "approved") continue; // only approved skills score
      const u = usageBySkill.get(skill.id);
      const count = u?.totalCount ?? 0;
      const distinct = u?.distinctUsers ?? 0;
      const rawMinutes = (skill.minutesPerUse ?? 0) * count;
      const teamBonus = distinct >= TEAM_BONUS_THRESHOLD ? TEAM_BONUS : 1.0;
      const weightedMinutes = rawMinutes * teamBonus;

      const entry = byUser.get(skill.createdByUserId) ?? {
        userId: skill.createdByUserId,
        minutesSaved: 0,
        rawMinutes: 0,
        runCount: 0,
        skillCount: 0,
        beneficiaries: 0,
        bountyCount: 0,
        score: 0,
      };
      entry.minutesSaved += weightedMinutes;
      entry.rawMinutes += rawMinutes;
      entry.runCount += count;
      entry.skillCount += 1;
      entry.beneficiaries = Math.max(entry.beneficiaries, distinct);
      byUser.set(skill.createdByUserId, entry);
    }

    const entries = [...byUser.values()].map((e) => ({ ...e, score: Math.round(e.minutesSaved) }));
    entries.sort((a, b) => b.score - a.score || b.runCount - a.runCount);
    return { period: periodMonth ?? "lifetime", entries };
  }

  // Record one use of a skill for the current (or given) month. Upsert increments.
  async function recordUsage(
    companyId: string,
    skillId: string,
    periodMonth: string,
    usedByUserId: string | null,
    usedByAgentId: string | null,
    increment = 1,
  ) {
    const [row] = await db
      .insert(companySkillUsage)
      .values({ companyId, skillId, periodMonth, usedByUserId, usedByAgentId, count: increment })
      .onConflictDoUpdate({
        target: [companySkillUsage.skillId, companySkillUsage.periodMonth, companySkillUsage.usedByUserId],
        set: { count: sql`${companySkillUsage.count} + ${increment}`, updatedAt: new Date() },
      })
      .returning();
    // Also bump the skill's lifetime install/usage signal is not needed here.
    return row ?? null;
  }

  return { compute, recordUsage };
}
