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

  // An agent's tool calls now carry a viewer whose userId is the agent's MAPPED
  // user (its direct agent_memberships join), not whoever triggered the run. So
  // when a campus head drives a member's agent, that agent reaches the member's
  // space and not the campus head's.
  it("an agent carrying its mapped user reaches that user's personal space", () => {
    const mappedToAlice = { userId: "alice", agentId: "agent-1", isPrivileged: false };
    expect(spaceScopeVisible(personalAlice, mappedToAlice)).toBe(true);
  });

  it("driving another user's agent does NOT expose the driver's own space", () => {
    // Campus head "bob" runs alice's agent: the viewer is alice's, so bob's own
    // personal space is out of reach for that agent.
    const personalBob = { accessScope: "personal", ownerUserId: "bob", slug: "personal-bob" };
    const aliceAgentViewer = { userId: "alice", agentId: "agent-1", isPrivileged: false };
    expect(spaceScopeVisible(personalBob, aliceAgentViewer)).toBe(false);
    expect(spaceScopeVisible(personalAlice, aliceAgentViewer)).toBe(true);
  });

  it("an agent is never privileged, so it cannot read a third party's space", () => {
    // The acting agent must not inherit the admin rights of whoever triggered
    // the run, or driving an agent would become a way to read everything.
    const agentViewer = { userId: "alice", agentId: "agent-1", isPrivileged: false };
    const personalCarol = { accessScope: "personal", ownerUserId: "carol", slug: "personal-carol" };
    expect(spaceScopeVisible(personalCarol, agentViewer)).toBe(false);
  });

  it("an agent with an ambiguous mapping (null user) still reads only its own space", () => {
    // resolveAgentMappedUserId returns null when an agent maps to several users,
    // rather than guessing and handing one user's space to another's agent.
    const unmapped = { userId: null, agentId: "agent-1", isPrivileged: false };
    expect(spaceScopeVisible(personalAlice, unmapped)).toBe(false);
    expect(spaceScopeVisible(agentSpace, unmapped)).toBe(true);
    expect(spaceScopeVisible(shared, unmapped)).toBe(true);
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

  // The company wiki: readable by admins and nobody else. This is the scope the
  // shared `default` space is converted to, so these cases pin the whole point
  // of the conversion.
  describe("admin scope (the company wiki)", () => {
    const companyWiki = { accessScope: "admin", slug: "default" };

    it("ALLOWS a privileged viewer (owner/admin/instance-admin)", () => {
      expect(spaceScopeVisible(companyWiki, { isPrivileged: true })).toBe(true);
    });

    it("DENIES an ordinary user", () => {
      expect(spaceScopeVisible(companyWiki, { userId: "alice" })).toBe(false);
    });

    it("DENIES an agent", () => {
      expect(spaceScopeVisible(companyWiki, { agentId: "agent-1" })).toBe(false);
      expect(spaceScopeVisible(companyWiki, { userId: "alice", agentId: "agent-1" })).toBe(false);
    });

    // Deliberately stricter than "personal": admin-only means admins, so being
    // named as the owner is not a way in.
    it("DENIES even the space's own owner", () => {
      expect(spaceScopeVisible(
        { accessScope: "admin", ownerUserId: "alice", ownerAgentId: "agent-1" },
        { userId: "alice", agentId: "agent-1" },
      )).toBe(false);
    });

    it("DENIES a team member of the space's team", () => {
      expect(spaceScopeVisible(
        { accessScope: "admin", teamKey: "leadership" },
        { userId: "alice", teams: ["leadership"] },
      )).toBe(false);
    });

    it("DENIES a viewer-less (trusted-path) caller", () => {
      expect(spaceScopeVisible(companyWiki, {})).toBe(false);
    });

    it("is case-insensitive, so a capitalised scope cannot open it up", () => {
      expect(spaceScopeVisible({ accessScope: "ADMIN" }, { userId: "alice" })).toBe(false);
    });
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
