import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills, companySkillUsage, monthlyAwards, skillBounties, authUsers } from "@paperclipai/db";
import { bountyService } from "./bounties.js";

// Scoring (mirrors the intended formula):
//   score = minutesSaved × teamBonus × bountyBonus
//   minutesSaved = Σ over the trainer's APPROVED skills (minutesPerUse × usageCount)
//   teamBonus    = 2.0 if a skill was used by ≥3 distinct people, else 1.0 (per-skill, applied to that skill's minutes)
//   bountyBonus  = 1.0 for now (activates with the bounty board, Phase 10C)
const TEAM_BONUS_THRESHOLD = 3;
const TEAM_BONUS = 2.0;
const BOUNTY_BONUS = 1.3;
const BOUNTY_WINDOW_DAYS = 90;

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
    const bounties = bountyService(db);
    const sinceMs = Date.now() - BOUNTY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const bountyUsers = await bounties.recentCompleters(companyId, sinceMs);
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

    const entries = [...byUser.values()].map((e) => {
      const hasBounty = bountyUsers.has(e.userId);
      const score = Math.round(e.minutesSaved * (hasBounty ? BOUNTY_BONUS : 1.0));
      return { ...e, bountyCount: hasBounty ? 1 : 0, score };
    });
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

  async function resolveNames(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(inArray(authUsers.id, ids));
    return new Map(rows.map((u) => [u.id, u.name ?? u.email ?? u.id.slice(0, 8)]));
  }

  // Compute the 6 monthly award winners from current data + usage + bounties,
  // then upsert them into monthly_awards (idempotent per company+month+award).
  async function runMonthlyRollup(companyId: string, periodMonth: string) {
    const monthStart = new Date(`${periodMonth}-01T00:00:00.000Z`);
    const monthEndExclusive = new Date(monthStart);
    monthEndExclusive.setUTCMonth(monthEndExclusive.getUTCMonth() + 1);

    const [monthResult, lifetimeResult, skills, usageRows, doneBounties] = await Promise.all([
      compute(companyId, periodMonth),
      compute(companyId, null),
      db.select({ id: companySkills.id, createdByUserId: companySkills.createdByUserId, categories: companySkills.categories, createdAt: companySkills.createdAt, approvalStatus: companySkills.approvalStatus })
        .from(companySkills).where(eq(companySkills.companyId, companyId)),
      db.select({ skillId: companySkillUsage.skillId, distinctUsers: sql<number>`count(distinct ${companySkillUsage.usedByUserId})::int` })
        .from(companySkillUsage)
        .where(and(eq(companySkillUsage.companyId, companyId), eq(companySkillUsage.periodMonth, periodMonth)))
        .groupBy(companySkillUsage.skillId),
      db.select({ claimedByUserId: skillBounties.claimedByUserId, completedAt: skillBounties.completedAt })
        .from(skillBounties).where(and(eq(skillBounties.companyId, companyId), eq(skillBounties.status, "done"))),
    ]);

    const skillById = new Map(skills.map((sk) => [sk.id, sk]));

    // champion: top monthly score
    const champion = monthResult.entries[0] ?? null;
    // lifetime: top lifetime score
    const lifetime = lifetimeResult.entries[0] ?? null;
    // crossDept: creator whose APPROVED skills span the most distinct categories (departments proxy)
    const catsByUser = new Map<string, Set<string>>();
    for (const sk of skills) {
      if (!sk.createdByUserId || sk.approvalStatus !== "approved") continue;
      const set = catsByUser.get(sk.createdByUserId) ?? new Set<string>();
      for (const c of sk.categories ?? []) set.add(c);
      catsByUser.set(sk.createdByUserId, set);
    }
    let crossDept: { userId: string; value: number } | null = null;
    for (const [userId, set] of catsByUser) {
      if (!crossDept || set.size > crossDept.value) crossDept = { userId, value: set.size };
    }
    // bounty: most bounties completed this month
    const bountyCounts = new Map<string, number>();
    for (const b of doneBounties) {
      if (!b.claimedByUserId || !b.completedAt) continue;
      if (b.completedAt < monthStart || b.completedAt >= monthEndExclusive) continue;
      bountyCounts.set(b.claimedByUserId, (bountyCounts.get(b.claimedByUserId) ?? 0) + 1);
    }
    let bounty: { userId: string; value: number } | null = null;
    for (const [userId, n] of bountyCounts) if (!bounty || n > bounty.value) bounty = { userId, value: n };
    // viral: single skill used by the most distinct people → its creator
    let viral: { userId: string; value: number } | null = null;
    for (const u of usageRows) {
      const sk = skillById.get(u.skillId);
      if (!sk?.createdByUserId) continue;
      if (!viral || u.distinctUsers > viral.value) viral = { userId: sk.createdByUserId, value: u.distinctUsers };
    }
    // rookie: among creators whose EARLIEST skill was created this month, the highest monthly score
    const earliestByUser = new Map<string, Date>();
    for (const sk of skills) {
      if (!sk.createdByUserId) continue;
      const cur = earliestByUser.get(sk.createdByUserId);
      if (!cur || sk.createdAt < cur) earliestByUser.set(sk.createdByUserId, sk.createdAt);
    }
    const rookieCandidates = monthResult.entries.filter((e) => {
      const earliest = earliestByUser.get(e.userId);
      return earliest && earliest >= monthStart && earliest < monthEndExclusive;
    });
    const rookie = rookieCandidates[0] ?? null;

    const winners: { awardKey: string; userId: string | null; value: number; detail: string | null }[] = [
      { awardKey: "champion", userId: champion?.userId ?? null, value: champion?.score ?? 0, detail: null },
      { awardKey: "lifetime", userId: lifetime?.userId ?? null, value: lifetime?.score ?? 0, detail: null },
      { awardKey: "crossDept", userId: crossDept?.userId ?? null, value: crossDept?.value ?? 0, detail: null },
      { awardKey: "bounty", userId: bounty?.userId ?? null, value: bounty?.value ?? 0, detail: null },
      { awardKey: "viral", userId: viral?.userId ?? null, value: viral?.value ?? 0, detail: null },
      { awardKey: "rookie", userId: rookie?.userId ?? null, value: rookie?.score ?? 0, detail: null },
    ];

    const names = await resolveNames(winners.map((w) => w.userId).filter((x): x is string => Boolean(x)));
    for (const w of winners) {
      await db.insert(monthlyAwards)
        .values({ companyId, periodMonth, awardKey: w.awardKey, winnerUserId: w.userId, winnerName: w.userId ? names.get(w.userId) ?? null : null, value: w.value, detail: w.detail })
        .onConflictDoUpdate({
          target: [monthlyAwards.companyId, monthlyAwards.periodMonth, monthlyAwards.awardKey],
          set: { winnerUserId: w.userId, winnerName: w.userId ? names.get(w.userId) ?? null : null, value: w.value, detail: w.detail, updatedAt: new Date() },
        });
    }
    return winners.map((w) => ({ ...w, winnerName: w.userId ? names.get(w.userId) ?? null : null }));
  }

  async function listAwards(companyId: string, periodMonth: string) {
    return db.select().from(monthlyAwards)
      .where(and(eq(monthlyAwards.companyId, companyId), eq(monthlyAwards.periodMonth, periodMonth)));
  }

  return { compute, recordUsage, runMonthlyRollup, listAwards };
}
