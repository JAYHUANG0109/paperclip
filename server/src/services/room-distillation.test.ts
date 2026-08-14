import { describe, it, expect } from "vitest";
import { renderRoomDistillationTask, ROOM_MEMORY_DISTILLATION_ORIGIN_KIND } from "./memory-distillation.js";

describe("renderRoomDistillationTask", () => {
  const digest = {
    companyId: "c",
    roomScopeId: "google_chat:spaces/AAA",
    since: null,
    issuesSince: 5,
    recentIssueTitles: ["[Google Chat] from Alice: hi", "purchase order Q3"],
    existingMemories: [{ name: "standup-time", memoryType: "reference", description: "mornings", timesObserved: 3 }],
  };

  it("directs the agent at the ROOM API with the roomScopeId", () => {
    const t = renderRoomDistillationTask(digest);
    expect(t.description).toContain("/api/companies/{companyId}/room-memories/{name}");
    expect(t.description).toContain("google_chat:spaces/AAA");
  });

  it("frames memory as shared to the room, not to a person", () => {
    const t = renderRoomDistillationTask(digest);
    expect(t.title).toMatch(/room remembers/i);
    expect(t.description).toMatch(/SHARED ROOM/);
    expect(t.description).toMatch(/private to one person/i);
  });

  it("includes existing room memory and recent activity, and uses a stable origin kind", () => {
    const t = renderRoomDistillationTask(digest);
    expect(t.description).toContain("standup-time");
    expect(t.description).toContain("purchase order Q3");
    expect(ROOM_MEMORY_DISTILLATION_ORIGIN_KIND).toBe("room_memory_distillation");
  });

  it("handles the first pass (no existing memory) cleanly", () => {
    const t = renderRoomDistillationTask({ ...digest, existingMemories: [] });
    expect(t.description).toMatch(/first pass/i);
  });
});
