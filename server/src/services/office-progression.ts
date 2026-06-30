import type { LeaderboardEntry } from "./leaderboard.js";

/**
 * Virtual Office progression — the gamification layer (XP, levels, titles,
 * coins, badges) computed PURELY from the leaderboard aggregates the platform
 * already tracks. No new data source: every input here comes from a
 * {@link LeaderboardEntry} (skill impact, personal usage, bounties, reuse).
 *
 * Two distinct quantities, on purpose:
 *   - XP   — lifetime, monotonic (only goes up). Sets level + title. Never spent.
 *   - Coin — minted 1:1 with XP, then SPENT in the cosmetics shop. Spending a
 *            coin never changes XP/level/rank, so status stays earned-not-bought.
 *
 * The level curve uses reach(L) = LEVEL_DIVISOR · (L−1)²  →  early levels arrive
 * fast, later ones cost progressively more, and there's no per-level table to
 * maintain (titles are just labels on bands). Tune LEVEL_DIVISOR to speed up or
 * slow down the whole ladder.
 */

/** Single dial for the whole curve. reach(L) = LEVEL_DIVISOR · (L−1)². */
export const LEVEL_DIVISOR = 30;

/** Weight on a user's own skill-usage minutes (authoring is weighted full). */
const PERSONAL_USAGE_WEIGHT = 0.5;
/** Flat XP per completed skill bounty. */
const XP_PER_BOUNTY = 300;

/** The ten named tiers (L1–L10). Beyond L10 the top title holds + a prestige number. */
export const TITLES: { zh: string; en: string }[] = [
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

export interface BadgeDef {
  key: string;
  /** Critter emoji shown until the illustrated badge art lands. */
  emoji: string;
  zh: string;
  en: string;
  /** One-time XP granted the first time the badge's condition is met. */
  xp: number;
  /** Earned when this predicate over the user's aggregates is true. */
  earned: (e: LeaderboardEntry) => boolean;
}

/**
 * Milestone badges, derived from existing aggregates — animal-themed to match the
 * cute-critter avatars. Earning one also grants its one-time XP (folded into
 * totalXp below), so badges and levels move together. Two little thematic arcs:
 * the beaver line rewards *building* skills, the howl→butterfly line rewards
 * *reach* (others adopting your work). Ordered roughly by difficulty.
 */
export const BADGES: BadgeDef[] = [
  // Building track (your skills) — beaver line.
  { key: "first_skill", emoji: "🐣", zh: "破殼新手", en: "Hatchling", xp: 100, earned: (e) => e.skillCount >= 1 },
  { key: "artisan", emoji: "🦫", zh: "勤奮海狸", en: "Busy Beaver", xp: 200, earned: (e) => e.skillCount >= 5 },
  { key: "master_artisan", emoji: "🦫", zh: "築壩大師", en: "Dam Master", xp: 400, earned: (e) => e.skillCount >= 10 },
  // Reach track (others adopting your work) — howl → butterfly.
  { key: "first_reuse", emoji: "🐺", zh: "初聲有應", en: "First Howl", xp: 200, earned: (e) => e.beneficiaries >= 1 },
  { key: "viral", emoji: "🦋", zh: "蝴蝶效應", en: "Butterfly Effect", xp: 500, earned: (e) => e.beneficiaries >= 10 },
  // Time-saved track.
  { key: "kilo_saver", emoji: "🐿️", zh: "松鼠存時", en: "Squirrel Stash", xp: 300, earned: (e) => e.minutesSaved >= 1000 },
  { key: "mega_saver", emoji: "🐘", zh: "省時巨象", en: "Time Elephant", xp: 600, earned: (e) => e.minutesSaved >= 5000 },
  // Personal-usage track (you adopting skills).
  { key: "helpful_dolphin", emoji: "🐬", zh: "助人海豚", en: "Helpful Dolphin", xp: 250, earned: (e) => e.usageMinutes >= 500 },
  { key: "worker_bee", emoji: "🐝", zh: "勤勞工蜂", en: "Worker Bee", xp: 200, earned: (e) => e.usesCount >= 25 },
  { key: "workhorse", emoji: "🐂", zh: "老黃牛", en: "Workhorse", xp: 400, earned: (e) => e.usesCount >= 100 },
  { key: "ant_army", emoji: "🐜", zh: "蟻群大軍", en: "Ant Army", xp: 350, earned: (e) => e.runCount >= 500 },
  // Bounty + overall.
  { key: "bounty_hunter", emoji: "🦊", zh: "狡狐獵手", en: "Sly Fox", xp: 150, earned: (e) => e.bountyCount >= 1 },
  { key: "bounty_tiger", emoji: "🐅", zh: "賞金猛虎", en: "Bounty Tiger", xp: 400, earned: (e) => e.bountyCount >= 5 },
  { key: "legend", emoji: "🦁", zh: "省時之王", en: "Pride Leader", xp: 800, earned: (e) => e.score >= 5000 },
  { key: "dragon", emoji: "🐉", zh: "真龍", en: "Dragon", xp: 1500, earned: (e) => e.score >= 20000 },
];

export interface EarnedBadge {
  key: string;
  emoji: string;
  zh: string;
  en: string;
  xp: number;
}

export interface OfficeProgression {
  /** Lifetime XP (monotonic): skill impact + ½ personal usage + bounties + milestone badges. */
  totalXp: number;
  level: number;
  title: { zh: string; en: string };
  /** XP needed to reach the next level (always ≥ 1 while below the implicit cap). */
  xpToNext: number;
  /** XP at the start of the current level — for a progress bar: (totalXp−base)/(next−base). */
  levelFloorXp: number;
  /** XP at which the next level begins (levelFloorXp + xpToNext). */
  nextLevelXp: number;
  /** Coins minted (= totalXp). Spendable balance = coinsMinted − coinsSpent. */
  coinsMinted: number;
  coinsBalance: number;
  badges: EarnedBadge[];
  /** Breakdown so the UI can show "where your XP came from". */
  breakdown: { skill: number; personal: number; bounty: number; milestone: number };
}

/** Cumulative XP required to *reach* a given level. reach(1) = 0. */
export function xpToReachLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return LEVEL_DIVISOR * (l - 1) * (l - 1);
}

/** Level for a given lifetime XP. Level 1 starts at 0 XP. */
export function levelForXp(totalXp: number): number {
  if (totalXp <= 0) return 1;
  return Math.floor(Math.sqrt(totalXp / LEVEL_DIVISOR)) + 1;
}

/** Title for a level: the ten named tiers, holding the top name past L10. */
export function titleForLevel(level: number): { zh: string; en: string } {
  const idx = Math.min(TITLES.length - 1, Math.max(0, level - 1));
  return TITLES[idx]!;
}

/** Milestone XP from all badges a user has earned. */
function milestoneXp(badges: EarnedBadge[]): number {
  return badges.reduce((sum, b) => sum + b.xp, 0);
}

/** The badges earned given a user's aggregates. */
export function badgesFor(entry: LeaderboardEntry): EarnedBadge[] {
  return BADGES.filter((b) => b.earned(entry)).map((b) => ({ key: b.key, emoji: b.emoji, zh: b.zh, en: b.en, xp: b.xp }));
}

/**
 * Compute the full progression for one leaderboard entry.
 * @param coinsSpent coins already spent in the shop (0 until the shop exists).
 */
export function progressionFor(entry: LeaderboardEntry, coinsSpent = 0): OfficeProgression {
  const skill = Math.round(entry.minutesSaved);
  const personal = Math.round(PERSONAL_USAGE_WEIGHT * entry.usageMinutes);
  const bounty = XP_PER_BOUNTY * entry.bountyCount;
  const badges = badgesFor(entry);
  const milestone = milestoneXp(badges);

  const totalXp = Math.max(0, skill + personal + bounty + milestone);
  const level = levelForXp(totalXp);
  const levelFloorXp = xpToReachLevel(level);
  const nextLevelXp = xpToReachLevel(level + 1);
  const coinsMinted = totalXp;

  return {
    totalXp,
    level,
    title: titleForLevel(level),
    xpToNext: Math.max(0, nextLevelXp - totalXp),
    levelFloorXp,
    nextLevelXp,
    coinsMinted,
    coinsBalance: Math.max(0, coinsMinted - Math.max(0, Math.round(coinsSpent))),
    badges,
    breakdown: { skill, personal, bounty, milestone },
  };
}

const OFFICE_LINK = "/virtual-office";

export interface ProgressionNotice {
  kind: string;
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
}

/**
 * The inbox notices a user should have, given their current progression. Each
 * carries a stable dedupeKey, so emitting these on the daily leaderboard sweep
 * announces every level and badge EXACTLY ONCE (a repeat sweep is a no-op via
 * the notification dedupe). We announce only the user's CURRENT level — never
 * the levels they passed through — and skip Level 1 since everyone starts there.
 */
export function progressionNotifications(userId: string, entry: LeaderboardEntry): ProgressionNotice[] {
  const p = progressionFor(entry);
  const out: ProgressionNotice[] = [];

  if (p.level >= 2) {
    out.push({
      kind: "office_level_up",
      dedupeKey: `office-level:${userId}:${p.level}`,
      title: `🆙 升級 Lv${p.level} ${p.title.zh} / Level ${p.level} ${p.title.en}`,
      body: `累積 ${p.totalXp.toLocaleString()} XP — 你為團隊省下的時間正在累積。 / ${p.totalXp.toLocaleString()} XP and climbing.`,
      link: OFFICE_LINK,
    });
  }

  for (const b of p.badges) {
    out.push({
      kind: "office_badge",
      dedupeKey: `office-badge:${userId}:${b.key}`,
      title: `${b.emoji} 新徽章：${b.zh} / New badge: ${b.en}`,
      body: `+${b.xp} XP`,
      link: OFFICE_LINK,
    });
  }

  return out;
}
