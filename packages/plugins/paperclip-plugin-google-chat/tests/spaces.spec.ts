import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { extractSpaceRef } from "../src/chat.js";
import { listKnownSpaces, rememberSpace, resolveSpaceName } from "../src/spaces.js";
import manifest from "../src/manifest.js";

function ctx() {
  return createTestHarness({ manifest, config: {} }).ctx;
}

describe("extractSpaceRef", () => {
  it("reads the space from a classic ROOM message event", () => {
    const ref = extractSpaceRef({
      type: "MESSAGE",
      space: { name: "spaces/R1", type: "ROOM", displayName: "領導團隊" },
      message: { text: "hi" }
    });
    expect(ref).toEqual({
      spaceName: "spaces/R1",
      spaceType: "ROOM",
      displayName: "領導團隊",
      eventType: "MESSAGE"
    });
  });

  it("reads the space from an add-on messagePayload event", () => {
    const ref = extractSpaceRef({
      chat: { messagePayload: { space: { name: "spaces/R2", type: "SPACE", displayName: "市政校區" }, message: {} } }
    });
    expect(ref?.spaceName).toBe("spaces/R2");
    expect(ref?.displayName).toBe("市政校區");
  });

  it("reads the space from an ADDED_TO_SPACE event", () => {
    const ref = extractSpaceRef({
      type: "ADDED_TO_SPACE",
      space: { name: "spaces/R3", type: "ROOM", displayName: "西屯校區" }
    });
    expect(ref?.spaceName).toBe("spaces/R3");
    expect(ref?.eventType).toBe("ADDED_TO_SPACE");
  });

  it("returns null when there is no space", () => {
    expect(extractSpaceRef({ foo: 1 })).toBeNull();
    expect(extractSpaceRef(null)).toBeNull();
  });
});

describe("space registry", () => {
  it("remembers a room and resolves it by exact name (case/space-insensitive)", async () => {
    const c = ctx();
    await rememberSpace(c, { spaceName: "spaces/R1", displayName: "領導團隊" });
    expect(await resolveSpaceName(c, "領導團隊")).toBe("spaces/R1");
    expect(await resolveSpaceName(c, "  領導團隊 ")).toBe("spaces/R1");
  });

  it("resolves by a unique partial name", async () => {
    const c = ctx();
    await rememberSpace(c, { spaceName: "spaces/R1", displayName: "領導團隊" });
    expect(await resolveSpaceName(c, "領導")).toBe("spaces/R1");
  });

  it("returns null on an ambiguous partial match", async () => {
    const c = ctx();
    await rememberSpace(c, { spaceName: "spaces/A", displayName: "市政校區行政" });
    await rememberSpace(c, { spaceName: "spaces/B", displayName: "市政校區教學" });
    expect(await resolveSpaceName(c, "市政校區")).toBeNull();
  });

  it("accepts a raw resource name only when it's a known room", async () => {
    const c = ctx();
    await rememberSpace(c, { spaceName: "spaces/R1", displayName: "領導團隊" });
    expect(await resolveSpaceName(c, "spaces/R1")).toBe("spaces/R1");
    expect(await resolveSpaceName(c, "spaces/UNKNOWN")).toBeNull();
  });

  it("upserts on re-learn: a rename updates the display name, no duplicate row", async () => {
    const c = ctx();
    await rememberSpace(c, { spaceName: "spaces/R1", displayName: "舊名" });
    await rememberSpace(c, { spaceName: "spaces/R1", displayName: "新名" });
    const all = await listKnownSpaces(c);
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe("新名");
    expect(await resolveSpaceName(c, "新名")).toBe("spaces/R1");
    expect(await resolveSpaceName(c, "舊名")).toBeNull();
  });

  it("returns null when nothing is learned yet", async () => {
    expect(await resolveSpaceName(ctx(), "領導團隊")).toBeNull();
  });
});
