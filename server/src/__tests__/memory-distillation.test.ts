import { describe, expect, it } from "vitest";
import {
  renderDistillationTask,
  type DistillationDigest,
} from "../services/memory-distillation.js";

/**
 * The distillation brief.
 *
 * This text IS the fix for "capture is only a prompt". The sweep guarantees the
 * task exists; what the task says is the only thing deciding whether anything
 * useful comes back. So the assertions here are about the instruction, not the
 * plumbing: it has to offer all four outcomes, show what is already remembered
 * before showing what is new, and make "nothing" a real answer.
 */

function digest(overrides: Partial<DistillationDigest> = {}): DistillationDigest {
  return {
    userId: "user-1",
    agentId: "agent-1",
    agentName: "Tina's Agent",
    since: new Date("2026-07-01T00:00:00.000Z"),
    runsSince: 12,
    issues: [
      { title: "Render the summer reel", status: "done", project: "Summer Show" },
      { title: "Book the studio", status: "todo", project: null },
    ],
    ownerComments: [
      { body: "Please always cc the client on the final render.", issueTitle: "Render the summer reel", at: new Date("2026-07-10") },
    ],
    existingMemories: [
      { name: "writes-in-chinese", memoryType: "preference", description: "Writes updates in Traditional Chinese", timesObserved: 4 },
    ],
    ...overrides,
  };
}

describe("the distillation brief", () => {
  /**
   * The single most important assertion in this file. An agent handed new
   * material and asked "what should you save?" will always find something —
   * naming "nothing" as an expected outcome is what stops the store filling
   * with plausible inventions.
   */
  it("makes saving nothing an expected outcome, not a failure", () => {
    const { description } = renderDistillationTask(digest());

    expect(description).toContain("save nothing");
    expect(description).toMatch(/expected outcome most of the time/i);
  });

  it("offers all four outcomes, so revising is as available as adding", () => {
    const { description } = renderDistillationTask(digest());

    for (const outcome of ["**Add**", "**Revise**", "**Confirm**", "**Nothing.**"]) {
      expect(description).toContain(outcome);
    }
  });

  // Reconciliation, not append: an agent that cannot see what is already stored
  // has no way to revise it and will file a near-duplicate instead.
  it("shows what is already remembered, with its strength", () => {
    const { description } = renderDistillationTask(digest());

    expect(description).toContain("What you already remember");
    expect(description).toContain("`writes-in-chinese`");
    expect(description).toContain("core");
  });

  it("says so plainly on a first pass rather than showing an empty list", () => {
    const { description } = renderDistillationTask(digest({ existingMemories: [] }));

    expect(description).toContain("This is the first pass.");
  });

  /**
   * The owner's own words are the best evidence there is — preferences arrive as
   * an aside on some unrelated task, and repetition across several is the only
   * thing that marks one as standing.
   */
  it("quotes what the person actually said", () => {
    const { description } = renderDistillationTask(digest());

    expect(description).toContain("What they said");
    expect(description).toContain("Please always cc the client on the final render.");
    expect(description).toContain("Render the summer reel");
  });

  it("restates the rules the write gate enforces", () => {
    const { description } = renderDistillationTask(digest());

    expect(description).toContain("OTHER people");
    expect(description).toContain("guessing at");
    expect(description).toMatch(/health, financial or identity/i);
    expect(description).toContain("1500 characters");
  });

  it("names every category the API will accept", () => {
    const { description } = renderDistillationTask(digest());

    for (const id of ["preference", "profile", "expertise", "project", "workflow", "feedback", "reference"]) {
      expect(description).toContain(id);
    }
  });

  it("addresses the API at the owner, not at whoever the run belongs to", () => {
    const { description } = renderDistillationTask(digest({ userId: "user-tina" }));

    expect(description).toContain("/users/user-tina/memories/");
  });

  // Deleting is recoverable, which is what makes an honest correction safe —
  // but an agent told only that will start tidying.
  it("permits correction but forbids tidying", () => {
    const { description } = renderDistillationTask(digest());

    expect(description).toContain("30 days");
    expect(description).toContain("do not tidy");
  });

  it("survives a first pass with no history and no dates", () => {
    const { description } = renderDistillationTask(
      digest({ since: null, runsSince: 0, issues: [], ownerComments: [], existingMemories: [] }),
    );

    expect(description).not.toContain("undefined");
    expect(description).not.toContain("null");
    expect(description).toContain("since you started");
  });
});
