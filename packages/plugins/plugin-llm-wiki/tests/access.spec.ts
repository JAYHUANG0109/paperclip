import { describe, expect, it } from "vitest";
import { assertSpaceAccess, spaceScopeVisible } from "../src/wiki/access.js";

const shared = { accessScope: "shared", slug: "default" };
const personalAlice = { accessScope: "personal", ownerUserId: "alice", slug: "personal-alice" };
const teamEng = { accessScope: "team", teamKey: "eng", slug: "team-eng" };
const agentSpace = { accessScope: "personal", ownerAgentId: "agent-1", slug: "agent-space" };

describe("spaceScopeVisible", () => {
  it("shared spaces are visible to anyone, even with no identity", () => {
    expect(spaceScopeVisible(shared, {})).toBe(true);
    expect(spaceScopeVisible(shared, { userId: "bob" })).toBe(true);
  });

  it("personal spaces are visible only to their owner user", () => {
    expect(spaceScopeVisible(personalAlice, { userId: "alice" })).toBe(true);
    expect(spaceScopeVisible(personalAlice, { userId: "bob" })).toBe(false);
    expect(spaceScopeVisible(personalAlice, {})).toBe(false);
  });

  it("agent-owned personal spaces are visible to that agent", () => {
    expect(spaceScopeVisible(agentSpace, { agentId: "agent-1" })).toBe(true);
    expect(spaceScopeVisible(agentSpace, { agentId: "agent-2" })).toBe(false);
    expect(spaceScopeVisible(agentSpace, { userId: "alice" })).toBe(false);
  });

  it("team spaces are visible to members of the team (and the owner)", () => {
    expect(spaceScopeVisible(teamEng, { userId: "bob", teams: ["eng", "design"] })).toBe(true);
    expect(spaceScopeVisible(teamEng, { userId: "bob", teams: ["design"] })).toBe(false);
    expect(spaceScopeVisible(teamEng, { userId: "bob" })).toBe(false);
  });

  it("privileged viewers (owner/admin/instance-admin) see everything", () => {
    expect(spaceScopeVisible(personalAlice, { userId: "bob", isPrivileged: true })).toBe(true);
    expect(spaceScopeVisible(teamEng, { isPrivileged: true })).toBe(true);
    expect(spaceScopeVisible({ accessScope: "personal", ownerUserId: "alice" }, { isPrivileged: true })).toBe(true);
  });

  it("fails CLOSED for unknown/misconfigured scopes (owner-only)", () => {
    const weird = { accessScope: "totally-bogus", ownerUserId: "alice" };
    expect(spaceScopeVisible(weird, { userId: "alice" })).toBe(true);
    expect(spaceScopeVisible(weird, { userId: "bob" })).toBe(false);
    expect(spaceScopeVisible(weird, {})).toBe(false);
  });

  it("empty accessScope defaults to shared (the default space has no scope surprises)", () => {
    expect(spaceScopeVisible({ accessScope: "" }, {})).toBe(true);
  });
});

describe("assertSpaceAccess", () => {
  it("passes silently when visible", () => {
    expect(() => assertSpaceAccess(shared, { userId: "bob" })).not.toThrow();
    expect(() => assertSpaceAccess(personalAlice, { userId: "alice" })).not.toThrow();
  });
  it("throws with the space slug when denied", () => {
    expect(() => assertSpaceAccess(personalAlice, { userId: "bob" })).toThrow(/personal-alice/);
  });
});
