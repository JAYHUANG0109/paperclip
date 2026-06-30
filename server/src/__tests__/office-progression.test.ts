import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "../services/leaderboard.js";
import {
  LEVEL_DIVISOR,
  badgesFor,
  levelForXp,
  progressionFor,
  progressionNotifications,
  titleForLevel,
  xpToReachLevel,
} from "../services/office-progression.js";

// Build a LeaderboardEntry with everything zeroed, overriding only what a test cares about.
function entry(over: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    userId: "u1",
    minutesSaved: 0,
    rawMinutes: 0,
    runCount: 0,
    skillCount: 0,
    beneficiaries: 0,
    bountyCount: 0,
    usageMinutes: 0,
    usesCount: 0,
    score: 0,
    ...over,
  };
}

describe("level curve", () => {
  it("starts everyone at level 1 (including zero/negative XP)", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-5)).toBe(1);
    expect(levelForXp(29)).toBe(1);
  });

  it("reach(L) = DIVISOR·(L−1)² and levelForXp is its inverse", () => {
    expect(xpToReachLevel(1)).toBe(0);
    expect(xpToReachLevel(2)).toBe(LEVEL_DIVISOR); // 30
    expect(xpToReachLevel(10)).toBe(2430);
    expect(xpToReachLevel(11)).toBe(3000);
    // crossing a threshold bumps the level exactly at reach(L)
    expect(levelForXp(30)).toBe(2);
    expect(levelForXp(2429)).toBe(9);
    expect(levelForXp(2430)).toBe(10);
  });

  it("matches the reference display (2480 XP → Lv10, 520 to the next at 3000)", () => {
    // Assert the curve directly so badge XP doesn't skew the input.
    expect(levelForXp(2480)).toBe(10);
    expect(xpToReachLevel(11)).toBe(3000);
    expect(3000 - 2480).toBe(520); // xpToNext at exactly 2480 XP
    expect(titleForLevel(levelForXp(2480)).zh).toBe("時間領主");
  });

  it("keeps the top title past L10 while the level number climbs", () => {
    expect(titleForLevel(1).zh).toBe("見習生");
    expect(titleForLevel(10).zh).toBe("時間領主");
    expect(titleForLevel(34).zh).toBe("時間領主");
    // a top contributor (~34k XP) is well past L10
    expect(levelForXp(34680)).toBeGreaterThanOrEqual(34);
  });
});

describe("XP sources & coins", () => {
  it("sums skill impact + ½ personal usage + bounties + milestone badges", () => {
    const p = progressionFor(
      entry({
        minutesSaved: 1000, // skill impact → 1000
        usageMinutes: 200, // personal → ×0.5 = 100
        bountyCount: 1, // → 300
        skillCount: 10,
        beneficiaries: 10,
      }),
    );
    // badges earned: first_skill+first_reuse+bounty_hunter+artisan+kilo_saver+master_artisan+viral
    const milestone = 100 + 200 + 150 + 200 + 300 + 400 + 500; // 1850
    expect(p.breakdown).toEqual({ skill: 1000, personal: 100, bounty: 300, milestone });
    expect(p.totalXp).toBe(1000 + 100 + 300 + milestone); // 3250
  });

  it("mints coins 1:1 with XP and subtracts what's been spent (rank unaffected)", () => {
    const e = entry({ minutesSaved: 3250 });
    const a = progressionFor(e, 0);
    const b = progressionFor(e, 1000);
    expect(a.coinsMinted).toBe(a.totalXp);
    expect(a.coinsBalance).toBe(a.totalXp);
    expect(b.coinsBalance).toBe(a.totalXp - 1000);
    // spending does NOT change XP or level
    expect(b.totalXp).toBe(a.totalXp);
    expect(b.level).toBe(a.level);
  });

  it("never goes negative on coins or empty stats", () => {
    const p = progressionFor(entry(), 999);
    expect(p.totalXp).toBe(0);
    expect(p.level).toBe(1);
    expect(p.coinsBalance).toBe(0);
    expect(p.badges).toEqual([]);
  });
});

describe("progression notifications", () => {
  it("emits nothing for a brand-new, empty contributor", () => {
    expect(progressionNotifications("u1", entry())).toEqual([]);
  });

  it("first badge bumps to Lv2 → a level-up notice + the badge notice, each deduped", () => {
    const notices = progressionNotifications("u1", entry({ skillCount: 1 }));
    const kinds = notices.map((n) => n.kind);
    expect(kinds).toEqual(["office_level_up", "office_badge"]);
    expect(notices[0]!.dedupeKey).toBe("office-level:u1:2");
    expect(notices[1]!.dedupeKey).toBe("office-badge:u1:first_skill");
  });

  it("announces only the current level (never the levels passed through) + all current badges", () => {
    const notices = progressionNotifications(
      "u1",
      entry({ minutesSaved: 1000, usageMinutes: 200, bountyCount: 1, skillCount: 10, beneficiaries: 10 }),
    );
    const levelNotices = notices.filter((n) => n.kind === "office_level_up");
    const badgeNotices = notices.filter((n) => n.kind === "office_badge");
    expect(levelNotices).toHaveLength(1); // one, for the current level only
    expect(badgeNotices).toHaveLength(7); // all seven badges earned
    // dedupeKeys are unique so the daily sweep can't double-notify
    const keys = notices.map((n) => n.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("badges", () => {
  it("awards only the milestones whose condition is met", () => {
    const keys = badgesFor(entry({ skillCount: 1 })).map((b) => b.key);
    expect(keys).toEqual(["first_skill"]);
  });

  it("escalates artisan → master_artisan with skill count", () => {
    expect(badgesFor(entry({ skillCount: 5 })).map((b) => b.key)).toContain("artisan");
    expect(badgesFor(entry({ skillCount: 5 })).map((b) => b.key)).not.toContain("master_artisan");
    expect(badgesFor(entry({ skillCount: 10 })).map((b) => b.key)).toContain("master_artisan");
  });
});
