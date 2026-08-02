import { describe, expect, it } from "vitest";
import { renderMemorySeedTask, seedIsWorthwhile, type MemorySeedDigest } from "../services/memory-seed.js";

/**
 * Seeding memory from work already done.
 *
 * The digest itself is a SQL aggregate and is covered where the DB is real; what
 * matters here is the brief handed to the agent, because that text is the whole
 * mechanism. It has to ask for patterns rather than a summary, restate the
 * limits the API enforces, and leave "nothing worth saving" available as an
 * answer — a seeding task that feels obliged to produce ten memories will
 * invent ten memories.
 */

function digest(overrides: Partial<MemorySeedDigest> = {}): MemorySeedDigest {
  return {
    userId: "user-1",
    agentNames: ["Tina's Agent"],
    totalIssues: 42,
    completedIssues: 30,
    projectCounts: [{ name: "Taipei Campus", count: 20 }, { name: "Summer Show", count: 8 }],
    recentTitles: [
      { title: "Render the summer reel", status: "done", project: "Summer Show", updatedAt: new Date("2026-07-01") },
      { title: "Book the studio", status: "todo", project: null, updatedAt: new Date("2026-06-28") },
    ],
    earliest: new Date("2026-01-01T00:00:00.000Z"),
    latest: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("the seeding brief", () => {
  it("asks for patterns rather than a summary of the list", () => {
    const { description } = renderMemorySeedTask(digest());

    expect(description).toContain("Patterns, not events");
    // The tasks are already on the board; restating them is a log, not a memory.
    expect(description).toContain("log, not a memory");
  });

  it("restates the rules the write gate enforces", () => {
    const { description } = renderMemorySeedTask(digest());

    expect(description).toContain("OTHER people");
    expect(description).toContain("guessing at");
    expect(description).toMatch(/health, financial or identity/i);
    expect(description).toContain("memoryType");
  });

  // Without this, a seeding task is a quota and the agent fills it.
  it("makes saving nothing an acceptable outcome", () => {
    const { description } = renderMemorySeedTask(digest());

    expect(description).toContain("save nothing");
  });

  it("addresses the memory API at the owner, not at whoever asked", () => {
    const { description } = renderMemorySeedTask(digest({ userId: "user-tina" }));

    expect(description).toContain("/users/user-tina/memories/");
  });

  it("includes the history the agent is meant to read", () => {
    const { description } = renderMemorySeedTask(digest());

    expect(description).toContain("Taipei Campus — 20 task(s)");
    expect(description).toContain("Render the summer reel [Summer Show] (done)");
    expect(description).toContain("42 tasks, 30 completed");
  });

  it("survives a history with no projects or dates", () => {
    const { description } = renderMemorySeedTask(
      digest({
        totalIssues: 0,
        completedIssues: 0,
        projectCounts: [],
        recentTitles: [],
        earliest: null,
        latest: null,
        agentNames: [],
      }),
    );

    expect(description).toContain("0 tasks");
    expect(description).not.toContain("undefined");
    expect(description).not.toContain("null");
  });
});

describe("whether seeding is worth offering", () => {
  it("is not, with no history to read", () => {
    expect(seedIsWorthwhile(digest({ totalIssues: 0 }))).toBe(false);
  });

  it("is, once there is any", () => {
    expect(seedIsWorthwhile(digest({ totalIssues: 1 }))).toBe(true);
  });
});
