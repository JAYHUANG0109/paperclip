import { api } from "./client";

export interface LeaderboardEntry {
  userId: string;
  displayName: string;
  minutesSaved: number;
  rawMinutes: number;
  runCount: number;
  skillCount: number;
  beneficiaries: number;
  bountyCount: number;
  score: number;
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
