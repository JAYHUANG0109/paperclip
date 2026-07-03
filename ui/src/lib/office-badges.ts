// Reference content for the Virtual Office "guide" (圖鑑): the 15 badges with
// their unlock requirements, and how levels/XP are calculated. The per-agent
// EARNED state comes from the API (agentsApi.progression); this module is the
// static legend the guide + tooltips render. Keys/emoji/targets/XP mirror
// server/src/services/agent-progression.ts — keep them in sync if tuned.

export interface OfficeBadgeInfo {
  key: string;
  emoji: string;
  zh: string;
  en: string;
  /** Human-readable unlock requirement. */
  reqZh: string;
  reqEn: string;
  /** One-time XP granted when earned. */
  xp: number;
}

export const OFFICE_BADGES: OfficeBadgeInfo[] = [
  { key: "first_assignment", emoji: "🎯", zh: "初次任務", en: "First Assignment", reqZh: "完成第一項任務", reqEn: "Complete your first task", xp: 100 },
  { key: "centurion", emoji: "💯", zh: "百戰達成", en: "Centurion", reqZh: "完成 100 項任務", reqEn: "Complete 100 tasks", xp: 600 },
  { key: "time_saver", emoji: "⏱️", zh: "省時新星", en: "Time Saver", reqZh: "透過技能省下 1,000 分鐘", reqEn: "Save 1,000 minutes via skills", xp: 300 },
  { key: "time_architect", emoji: "🏛️", zh: "時間建築師", en: "Time Architect", reqZh: "透過技能省下 10,000 分鐘", reqEn: "Save 10,000 minutes via skills", xp: 800 },
  { key: "toolsmith", emoji: "🛠️", zh: "技能工匠", en: "Toolsmith", reqZh: "運用 10 種不同技能", reqEn: "Use 10 different skills", xp: 300 },
  { key: "bounty_breaker", emoji: "💰", zh: "懸賞剋星", en: "Bounty Breaker", reqZh: "完成 5 項懸賞", reqEn: "Claim 5 bounties", xp: 400 },
  { key: "flawless", emoji: "💎", zh: "零瑕紀錄", en: "Flawless Record", reqZh: "完成 20 項任務且零退件", reqEn: "Complete 20 tasks with zero revision requests", xp: 500 },
  { key: "one_shot", emoji: "🥇", zh: "一次到位", en: "One-Shot", reqZh: "10 次審查一次通過（無退件）", reqEn: "Pass 10 reviews on the first submission", xp: 400 },
  { key: "ahead_of_time", emoji: "🚀", zh: "超前交付", en: "Ahead of Time", reqZh: "15 項任務於期限前完成", reqEn: "Deliver 15 tasks before their due date", xp: 400 },
  { key: "rapid_response", emoji: "⚡", zh: "神速回應", en: "Rapid Response", reqZh: "10 次於指派後數分鐘內接手", reqEn: "Pick up 10 tasks within minutes of assignment", xp: 300 },
  { key: "polymath", emoji: "🧠", zh: "全能通才", en: "Polymath", reqZh: "運用的技能橫跨 5 個領域", reqEn: "Use skills spanning 5 domains", xp: 400 },
  { key: "reliable", emoji: "🛡️", zh: "全勤穩定", en: "Reliable", reqZh: "連續 4 週每個工作日皆活躍", reqEn: "Be active every workday for 4 straight weeks", xp: 500 },
  { key: "on_a_roll", emoji: "🔥", zh: "連勝氣勢", en: "On a Roll", reqZh: "連續 30 天保持活躍", reqEn: "Keep a 30-day activity streak", xp: 500 },
  { key: "collaborator", emoji: "🤝", zh: "協作夥伴", en: "Collaborator", reqZh: "交付／協作 25 項任務", reqEn: "Hand off or collaborate on 25 tasks", xp: 350 },
  { key: "mentor", emoji: "🧭", zh: "領路人", en: "Mentor", reqZh: "帶領下屬完成 20 項任務", reqEn: "Oversee sub-agents on 20 completed tasks", xp: 500 },
];

export const OFFICE_BADGE_BY_KEY: Record<string, OfficeBadgeInfo> = Object.fromEntries(
  OFFICE_BADGES.map((b) => [b.key, b]),
);

// ---- Levels ----
// XP = minutes saved + (tasks completed × 20) + one-time badge bonuses.
// The level curve is reach(L) = 30·(L−1)² (early levels arrive fast, later ones
// cost progressively more), so level = floor(sqrt(XP / 30)) + 1.
export const LEVEL_DIVISOR = 30;
export const XP_PER_TASK = 20;

export const RANK_TITLES: { zh: string; en: string }[] = [
  { zh: "見習生", en: "Apprentice" },
  { zh: "自動化學徒", en: "Automation Trainee" },
  { zh: "流程能手", en: "Process Hand" },
  { zh: "效率達人", en: "Efficiency Pro" },
  { zh: "時間管理師", en: "Time Manager" },
  { zh: "自動化專家", en: "Automation Expert" },
  { zh: "工時大師", en: "Hours Master" },
  { zh: "效率宗師", en: "Efficiency Grandmaster" },
  { zh: "自動化宗師", en: "Automation Grandmaster" },
  { zh: "時間領主", en: "Time Lord" },
];

/** Cumulative XP required to reach a level. reach(1) = 0. */
export function xpToReachLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return LEVEL_DIVISOR * (l - 1) * (l - 1);
}

/** The rank ladder for the guide: each named tier and the XP it starts at. */
export function rankLadder(): { level: number; zh: string; en: string; xp: number }[] {
  return RANK_TITLES.map((t, i) => ({ level: i + 1, zh: t.zh, en: t.en, xp: xpToReachLevel(i + 1) }));
}

/** The XP sources, for the "how levels work" explainer. */
export const XP_SOURCES: { zh: string; en: string }[] = [
  { zh: "每完成一項任務 +20 XP", en: "+20 XP for each task completed" },
  { zh: "透過技能省下的每分鐘 +1 XP", en: "+1 XP per minute saved through skills" },
  { zh: "每解鎖一枚徽章 +100～800 XP（一次性）", en: "+100–800 XP each time a badge is unlocked (one-time)" },
];
