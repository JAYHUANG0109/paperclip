import { api } from "./client";

export interface EarnedBadge {
  key: string;
  emoji: string;
  zh: string;
  en: string;
  xp: number;
}

// Virtual Office gamification layer, computed server-side from the entry.
// See server/src/services/office-progression.ts.
export interface OfficeProgression {
  totalXp: number;
  level: number;
  title: { zh: string; en: string };
  xpToNext: number;
  levelFloorXp: number;
  nextLevelXp: number;
  coinsMinted: number;
  coinsBalance: number;
  badges: EarnedBadge[];
  breakdown: { skill: number; personal: number; bounty: number; milestone: number };
}

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  minutesSaved: number;
  rawMinutes: number;
  runCount: number;
  skillCount: number;
  beneficiaries: number;
  bountyCount: number;
  usageMinutes: number;
  usesCount: number;
  score: number;
  progression?: OfficeProgression;
}

export interface MonthlyAward {
  awardKey: string;
  winnerUserId: string | null;
  winnerName: string | null;
  value: number;
  detail: string | null;
}

export interface LeaderboardResult {
  period: string;
  entries: LeaderboardEntry[];
  awards?: MonthlyAward[];
}

export const leaderboardApi = {
  get: (companyId: string, period?: string) =>
    api.get<LeaderboardResult>(
      `/companies/${encodeURIComponent(companyId)}/leaderboard${period ? `?period=${encodeURIComponent(period)}` : ""}`,
    ),
};
