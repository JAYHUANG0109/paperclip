import { describe, it, expect } from "vitest";
import { resolveRoomScope, roomMemoryEnabled } from "./room-memory.js";

describe("resolveRoomScope", () => {
  it("recognizes a group-room originId (surface-prefixed)", () => {
    expect(resolveRoomScope("google_chat:spaces/AAA")).toEqual({
      surface: "google_chat",
      roomScopeId: "google_chat:spaces/AAA",
      spaceName: "spaces/AAA",
    });
    expect(resolveRoomScope("line:group123")).toMatchObject({ surface: "line", spaceName: "group123" });
  });

  it("returns null for DMs / non-chat / malformed originIds (stays per-user)", () => {
    // DMs carry no room originId at all (Phase 1b only stamps group spaces).
    expect(resolveRoomScope(null)).toBeNull();
    expect(resolveRoomScope(undefined)).toBeNull();
    expect(resolveRoomScope("")).toBeNull();
    // An originId from some other source (unknown surface prefix) is not a room.
    expect(resolveRoomScope("recovery-incident-abc")).toBeNull();
    expect(resolveRoomScope("slack:foo")).toBeNull(); // surface not enabled
    // Malformed: prefix present but no space id.
    expect(resolveRoomScope("google_chat:")).toBeNull();
    expect(resolveRoomScope(":spaces/AAA")).toBeNull();
  });

  it("keeps the full prefixed id as the room scope so it round-trips with the issue originId", () => {
    const scope = resolveRoomScope("google_chat:spaces/AAA/threads/T1");
    expect(scope?.roomScopeId).toBe("google_chat:spaces/AAA/threads/T1");
    expect(scope?.spaceName).toBe("spaces/AAA/threads/T1");
  });

  it("is disabled by default (nothing changes until an operator opts in)", () => {
    expect(roomMemoryEnabled()).toBe(false);
  });
});
