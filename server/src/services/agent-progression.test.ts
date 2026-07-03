import { describe, expect, it } from "vitest";
import {
  AGENT_BADGES,
  agentProgressionFor,
  computeStreaks,
  emptyMetrics,
} from "./agent-progression.js";

describe("agentProgressionFor", () => {
  it("gives a fresh agent Level 1, zero XP, and no earned badges", () => {
    const p = agentProgressionFor(emptyMetrics());
    expect(p.level).toBe(1);
    expect(p.totalXp).toBe(0);
    expect(p.earnedCount).toBe(0);
    expect(p.badges).toHaveLength(15);
    expect(p.badges.every((b) => !b.earned)).toBe(true);
  });

  it("earns First Assignment on the first completed task and grants its XP", () => {
    const p = agentProgressionFor({ ...emptyMetrics(), tasksCompleted: 1 });
    const first = p.badges.find((b) => b.key === "first_assignment")!;
    expect(first.earned).toBe(true);
    // base XP = 1 task * 20 + badge XP 100 = 120
    expect(p.totalXp).toBe(120);
    expect(p.level).toBeGreaterThanOrEqual(2);
  });

  it("gates Flawless/One-Shot on a clean review record", () => {
    const clean = agentProgressionFor({ ...emptyMetrics(), tasksCompleted: 25, reviewsApproved: 12 });
    expect(clean.badges.find((b) => b.key === "flawless")!.earned).toBe(true);
    expect(clean.badges.find((b) => b.key === "one_shot")!.earned).toBe(true);

    const withRevision = agentProgressionFor({
      ...emptyMetrics(),
      tasksCompleted: 25,
      reviewsApproved: 12,
      revisionsRequested: 1,
    });
    expect(withRevision.badges.find((b) => b.key === "flawless")!.earned).toBe(false);
    expect(withRevision.badges.find((b) => b.key === "one_shot")!.earned).toBe(false);
    // progress collapses to 0 when the record isn't clean
    expect(withRevision.badges.find((b) => b.key === "flawless")!.current).toBe(0);
  });

  it("reports capped progress for locked badges", () => {
    const p = agentProgressionFor({ ...emptyMetrics(), tasksCompleted: 40 });
    const centurion = p.badges.find((b) => b.key === "centurion")!;
    expect(centurion.earned).toBe(false);
    expect(centurion.current).toBe(40);
    expect(centurion.target).toBe(100);
  });

  it("has 15 unique badge keys and unique emoji, none animal-adjacent duplicates", () => {
    const keys = new Set(AGENT_BADGES.map((b) => b.key));
    const emoji = new Set(AGENT_BADGES.map((b) => b.emoji));
    expect(keys.size).toBe(15);
    expect(emoji.size).toBe(15);
  });

  it("earns Priority Closer from high-priority tasks (re-wired off the unused bounty board)", () => {
    const p = agentProgressionFor({ ...emptyMetrics(), highPriorityDone: 15 });
    expect(p.badges.find((b) => b.key === "priority_closer")!.earned).toBe(true);
    expect(p.badges.find((b) => b.key === "priority_closer")!.target).toBe(15);
  });

  it("earns Polymath from breadth across projects", () => {
    expect(agentProgressionFor({ ...emptyMetrics(), distinctProjects: 3 }).badges.find((b) => b.key === "polymath")!.earned).toBe(true);
    expect(agentProgressionFor({ ...emptyMetrics(), distinctProjects: 2 }).badges.find((b) => b.key === "polymath")!.earned).toBe(false);
  });
});

describe("computeStreaks", () => {
  it("returns zero for no activity", () => {
    expect(computeStreaks([])).toEqual({ streakDays: 0, reliableWeeks: 0 });
  });

  it("finds the longest consecutive-day streak", () => {
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-10"];
    expect(computeStreaks(days).streakDays).toBe(3);
  });

  it("counts consecutive fully-covered work weeks (Mon–Fri)", () => {
    // 2026-06-01 is a Monday. Two full Mon–Fri weeks back to back.
    const wk1 = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"];
    const wk2 = ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12"];
    expect(computeStreaks([...wk1, ...wk2]).reliableWeeks).toBe(2);
  });

  it("does not count a work week that is missing a weekday", () => {
    // Friday 2026-06-05 missing → week incomplete.
    const partial = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    expect(computeStreaks(partial).reliableWeeks).toBe(0);
  });
});
