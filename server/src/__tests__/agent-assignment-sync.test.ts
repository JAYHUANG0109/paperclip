import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_SYNC_SOURCE,
  MANUAL_SOURCE,
  applyPlanToAssignments,
  isNoopPlan,
  reconcileAgentAssignments,
  type AgentFacts,
  type AssignmentRecord,
  type MembershipRecord,
} from "../services/agent-assignment-sync.js";

const COMPANY = "company-1";
const NOW = "2026-08-01T00:00:00.000Z";

function agent(id: string, name: string, status = "active"): AgentFacts {
  return { id, name, companyId: COMPANY, status };
}

function membership(over: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    id: `mem-${over.agentId ?? "a"}-${over.userId ?? "u"}`,
    companyId: COMPANY,
    agentId: "agent-1",
    userId: "user-1",
    source: MANUAL_SOURCE,
    state: "joined",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function assignment(over: Partial<AssignmentRecord> = {}): AssignmentRecord {
  return {
    email: "lucy@seasonart.org",
    agentId: "agent-1",
    agentName: "Lucy Agent",
    companyId: COMPANY,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

type Fixture = {
  memberships?: MembershipRecord[];
  assignments?: Record<string, AssignmentRecord>;
  users?: Record<string, string>; // userId -> email
  agents?: AgentFacts[];
};

function run(fixture: Fixture) {
  const users = fixture.users ?? { "user-1": "lucy@seasonart.org" };
  const agents = fixture.agents ?? [agent("agent-1", "Lucy Agent")];
  return reconcileAgentAssignments({
    memberships: fixture.memberships ?? [],
    assignments: fixture.assignments ?? {},
    emailByUserId: new Map(Object.entries(users)),
    userIdByEmail: new Map(Object.entries(users).map(([id, email]) => [email, id])),
    agentsById: new Map(agents.map((a) => [a.id, a])),
    now: NOW,
  });
}

describe("reconcileAgentAssignments", () => {
  it("does nothing when both stores already agree", () => {
    const plan = run({
      memberships: [membership()],
      assignments: { "lucy@seasonart.org": assignment({ source: ASSIGNMENT_SYNC_SOURCE }) },
    });

    expect(isNoopPlan(plan)).toBe(true);
    expect(plan.unresolvedEmails).toEqual([]);
  });

  // The handshake that makes the whole thing convergent: an entry an admin
  // typed is hand-made until a membership backs it, then it becomes derived.
  // Without this one-time stamp every entry would keep re-creating its
  // membership forever, so deleting a membership in Paperclip would never
  // actually revoke access.
  describe("provenance handshake", () => {
    it("stamps a hand-made entry as derived once a membership backs it", () => {
      const plan = run({
        memberships: [membership()],
        assignments: { "lucy@seasonart.org": assignment() },
      });

      expect(plan.mapUpserts).toHaveLength(1);
      expect(plan.mapUpserts[0].source).toBe(ASSIGNMENT_SYNC_SOURCE);
      expect(plan.mapUpserts[0].agentId).toBe("agent-1");
      expect(plan.dbInserts).toEqual([]);
    });

    it("settles after that one stamp", () => {
      const before = { "lucy@seasonart.org": assignment() };
      const first = run({ memberships: [membership()], assignments: before });
      const after = applyPlanToAssignments(before, first);

      expect(isNoopPlan(run({ memberships: [membership()], assignments: after }))).toBe(true);
    });

    it("emits exactly one upsert when an entry is both promoted and refreshed", () => {
      const plan = run({
        memberships: [membership()],
        assignments: { "lucy@seasonart.org": assignment({ agentName: "Stale" }) },
      });

      expect(plan.mapUpserts).toHaveLength(1);
      expect(plan.mapUpserts[0]).toMatchObject({
        agentName: "Lucy Agent",
        source: ASSIGNMENT_SYNC_SOURCE,
      });
    });

    // The revocation path this handshake exists to enable.
    it("lets a derived entry go when its membership is deleted in Paperclip", () => {
      const plan = run({
        memberships: [],
        assignments: { "lucy@seasonart.org": assignment({ source: ASSIGNMENT_SYNC_SOURCE }) },
      });

      expect(plan.dbInserts).toEqual([]);
      expect(plan.mapRemovals).toEqual([
        { email: "lucy@seasonart.org", reason: "membership removed in Paperclip" },
      ]);
    });
  });

  // The 7-of-43 case on the live instance: people who have never signed in have
  // no user row, so they can never have a membership. A sync that "projects the
  // DB over the map" would delete them and the bot would stop answering them.
  it("preserves assignments for people with no Paperclip account", () => {
    const plan = run({
      memberships: [],
      assignments: { "popo@seasonart.org": assignment({ email: "popo@seasonart.org" }) },
      users: {},
    });

    expect(plan.unresolvedEmails).toEqual(["popo@seasonart.org"]);
    expect(plan.mapRemovals).toEqual([]);
    expect(plan.dbInserts).toEqual([]);
    expect(isNoopPlan(plan)).toBe(true);
  });

  it("keeps preserving them across repeated syncs (idempotent)", () => {
    const assignments = { "popo@seasonart.org": assignment({ email: "popo@seasonart.org" }) };
    const first = run({ assignments, users: {} });
    const after = applyPlanToAssignments(assignments, first);
    const second = run({ assignments: after, users: {} });

    expect(after).toEqual(assignments);
    expect(isNoopPlan(second)).toBe(true);
  });

  describe("map → DB", () => {
    it("creates a membership for an assignment typed on the 代理指派 page", () => {
      const plan = run({
        memberships: [],
        assignments: { "lucy@seasonart.org": assignment() },
      });

      expect(plan.dbInserts).toEqual([
        { companyId: COMPANY, agentId: "agent-1", userId: "user-1", source: ASSIGNMENT_SYNC_SOURCE },
      ]);
    });

    // Ordering guarantee: a fresh page edit must not be read as "no membership,
    // therefore drop the entry" by the DB → map pass in the same run.
    it("does not revert a fresh edit it just turned into a membership", () => {
      const plan = run({ memberships: [], assignments: { "lucy@seasonart.org": assignment() } });

      expect(plan.dbInserts).toHaveLength(1);
      expect(plan.mapRemovals).toEqual([]);
    });

    it("does not duplicate a membership that already exists", () => {
      const plan = run({
        memberships: [membership()],
        assignments: { "lucy@seasonart.org": assignment() },
      });

      expect(plan.dbInserts).toEqual([]);
    });
  });

  describe("DB → map", () => {
    it("adds a map entry for a membership the map does not know about", () => {
      const plan = run({ memberships: [membership()], assignments: {} });

      expect(plan.mapUpserts).toEqual([
        {
          email: "lucy@seasonart.org",
          agentId: "agent-1",
          agentName: "Lucy Agent",
          companyId: COMPANY,
          updatedAt: NOW,
          source: ASSIGNMENT_SYNC_SOURCE,
        },
      ]);
    });

    // When a hand-made membership and a hand-made assignment name DIFFERENT
    // agents, neither is a mistake to be overwritten — memberships are
    // many-to-many, so owning two agents is legal. The union is taken: the
    // assignment is promoted to a second membership and the map keeps naming
    // what it named. Nothing is destroyed, and the extra is reported.
    it("takes the union when a membership and an assignment name different agents", () => {
      const plan = run({
        memberships: [membership({ agentId: "agent-2" })],
        assignments: { "lucy@seasonart.org": assignment({ agentId: "agent-1" }) },
        agents: [agent("agent-1", "Lucy Agent"), agent("agent-2", "Other Agent")],
      });

      expect(plan.dbInserts).toEqual([
        { companyId: COMPANY, agentId: "agent-1", userId: "user-1", source: ASSIGNMENT_SYNC_SOURCE },
      ]);
      expect(plan.dbRemovals).toEqual([]);
      // The map keeps naming agent-1; the only write is the provenance stamp.
      expect(plan.mapUpserts).toHaveLength(1);
      expect(plan.mapUpserts[0].agentId).toBe("agent-1");
      expect(plan.unrepresented).toEqual([{ email: "lucy@seasonart.org", agentIds: ["agent-2"] }]);
    });

    it("refreshes a stale cached agent name", () => {
      const plan = run({
        memberships: [membership()],
        assignments: { "lucy@seasonart.org": assignment({ agentName: "Old Name" }) },
      });

      expect(plan.mapUpserts[0].agentName).toBe("Lucy Agent");
    });

    it("preserves the original-case email an admin typed", () => {
      const plan = run({
        memberships: [membership()],
        assignments: { "lucy@seasonart.org": assignment({ email: "Lucy@SeasonArt.org", agentName: "Old" }) },
      });

      expect(plan.mapUpserts[0].email).toBe("Lucy@SeasonArt.org");
    });

    it("ignores memberships that are not joined", () => {
      const plan = run({ memberships: [membership({ state: "pending" })], assignments: {} });

      expect(isNoopPlan(plan)).toBe(true);
    });

    it("ignores memberships whose user has no known email", () => {
      const plan = run({ memberships: [membership({ userId: "ghost" })], assignments: {} });

      expect(isNoopPlan(plan)).toBe(true);
    });
  });

  describe("removals stay inside each side's own provenance", () => {
    // A hand-made entry must survive even when the person HAS an account and no
    // membership exists — it gets promoted to a membership, never deleted.
    it("never removes a hand-made map entry", () => {
      const plan = run({
        memberships: [],
        assignments: { "lucy@seasonart.org": assignment({ source: MANUAL_SOURCE }) },
      });

      expect(plan.mapRemovals).toEqual([]);
    });

    // Deleting a row on the page must actually revoke access. The retraction is
    // decided before the DB → map projection runs, otherwise the projection
    // would re-add the entry the admin just deleted AND the row would still be
    // removed — leaving the two stores permanently disagreeing.
    it("deletes its own membership when the assignment is removed, without re-adding the entry", () => {
      const plan = run({
        memberships: [membership({ id: "mine", source: ASSIGNMENT_SYNC_SOURCE })],
        assignments: {},
      });

      expect(plan.dbRemovals).toEqual([{ id: "mine", reason: expect.any(String) }]);
      expect(plan.mapUpserts).toEqual([]);
    });

    // Same situation, different provenance: a membership granted in Paperclip
    // outlives the Chat page, so it is projected back into the map instead.
    it("re-adds a map entry for a manual membership the page never had", () => {
      const plan = run({
        memberships: [membership({ id: "hand", source: MANUAL_SOURCE })],
        assignments: {},
      });

      expect(plan.dbRemovals).toEqual([]);
      expect(plan.mapUpserts).toHaveLength(1);
      expect(plan.mapUpserts[0].agentId).toBe("agent-1");
    });

    it("never deletes a manual membership because of a Chat-side edit", () => {
      const plan = run({
        memberships: [membership({ id: "hand", source: MANUAL_SOURCE, agentId: "agent-2" })],
        assignments: { "lucy@seasonart.org": assignment({ agentId: "agent-1" }) },
        agents: [agent("agent-1", "Lucy Agent"), agent("agent-2", "Other Agent")],
      });

      expect(plan.dbRemovals).toEqual([]);
    });

    it("never deletes a claimed_on_login membership", () => {
      const plan = run({
        memberships: [membership({ id: "claimed", source: "claimed_on_login", agentId: "agent-2" })],
        assignments: { "lucy@seasonart.org": assignment({ agentId: "agent-1" }) },
        agents: [agent("agent-1", "Lucy Agent"), agent("agent-2", "Other Agent")],
      });

      expect(plan.dbRemovals).toEqual([]);
    });

    it("deletes its own membership when the page repoints the person elsewhere", () => {
      const plan = run({
        memberships: [membership({ id: "mine", source: ASSIGNMENT_SYNC_SOURCE, agentId: "agent-2" })],
        assignments: { "lucy@seasonart.org": assignment({ agentId: "agent-1" }) },
        agents: [agent("agent-1", "Lucy Agent"), agent("agent-2", "Other Agent")],
      });

      expect(plan.dbRemovals).toEqual([{ id: "mine", reason: expect.any(String) }]);
      expect(plan.dbInserts).toHaveLength(1);
      expect(plan.dbInserts[0].agentId).toBe("agent-1");
    });
  });

  describe("dead agents", () => {
    it("drops a map entry pointing at an agent that no longer exists", () => {
      const plan = run({
        assignments: { "lucy@seasonart.org": assignment({ agentId: "ghost" }) },
        agents: [],
      });

      expect(plan.mapRemovals).toEqual([{ email: "lucy@seasonart.org", reason: expect.stringContaining("no longer exists") }]);
      expect(plan.dbInserts).toEqual([]);
    });

    it("drops a map entry pointing at a terminated agent, whatever its source", () => {
      const plan = run({
        assignments: { "lucy@seasonart.org": assignment({ source: MANUAL_SOURCE }) },
        agents: [agent("agent-1", "Lucy Agent", "terminated")],
      });

      expect(plan.mapRemovals[0].reason).toContain("terminated");
    });

    it("does not project a membership whose agent is terminated", () => {
      const plan = run({
        memberships: [membership()],
        assignments: {},
        agents: [agent("agent-1", "Lucy Agent", "terminated")],
      });

      expect(isNoopPlan(plan)).toBe(true);
    });
  });

  describe("a person who owns several agents", () => {
    const twoAgents = [agent("agent-1", "First"), agent("agent-2", "Second")];

    it("keeps whatever the map already names instead of flip-flopping", () => {
      const plan = run({
        memberships: [
          membership({ id: "m1", agentId: "agent-1", createdAt: "2026-01-01T00:00:00.000Z" }),
          membership({ id: "m2", agentId: "agent-2", createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
        assignments: {
          "lucy@seasonart.org": assignment({
            agentId: "agent-2",
            agentName: "Second",
            source: ASSIGNMENT_SYNC_SOURCE,
          }),
        },
        agents: twoAgents,
      });

      expect(plan.mapUpserts).toEqual([]);
      expect(plan.unrepresented).toEqual([{ email: "lucy@seasonart.org", agentIds: ["agent-1"] }]);
    });

    it("picks the oldest membership deterministically when the map is empty", () => {
      const plan = run({
        memberships: [
          membership({ id: "m2", agentId: "agent-2", createdAt: "2026-02-01T00:00:00.000Z" }),
          membership({ id: "m1", agentId: "agent-1", createdAt: "2026-01-01T00:00:00.000Z" }),
        ],
        assignments: {},
        agents: twoAgents,
      });

      expect(plan.mapUpserts[0].agentId).toBe("agent-1");
      expect(plan.unrepresented).toEqual([{ email: "lucy@seasonart.org", agentIds: ["agent-2"] }]);
    });
  });

  describe("convergence", () => {
    it("reaches a fixed point after one apply", () => {
      const assignments = {
        "lucy@seasonart.org": assignment(),
        "popo@seasonart.org": assignment({ email: "popo@seasonart.org", agentId: "agent-2", agentName: "Second" }),
      };
      const memberships = [membership({ id: "m3", userId: "user-3", agentId: "agent-3" })];
      const users = { "user-1": "lucy@seasonart.org", "user-3": "kim@seasonart.org" };
      const agents = [agent("agent-1", "Lucy Agent"), agent("agent-2", "Second"), agent("agent-3", "Third")];

      const first = run({ memberships, assignments, users, agents });
      expect(isNoopPlan(first)).toBe(false);

      const nextMap = applyPlanToAssignments(assignments, first);
      const nextMemberships = [
        ...memberships.filter((m) => !first.dbRemovals.some((r) => r.id === m.id)),
        ...first.dbInserts.map((i, idx) =>
          membership({ id: `new-${idx}`, ...i, state: "joined", createdAt: NOW }),
        ),
      ];

      const second = run({ memberships: nextMemberships, assignments: nextMap, users, agents });
      expect(isNoopPlan(second)).toBe(true);
      // popo has no account, so the entry survives untouched.
      expect(nextMap["popo@seasonart.org"]).toEqual(assignments["popo@seasonart.org"]);
    });
  });
});

describe("applyPlanToAssignments", () => {
  it("applies removals before upserts and keys by lowercased email", () => {
    const before = { "lucy@seasonart.org": assignment({ agentId: "agent-1" }) };
    const plan = reconcileAgentAssignments({
      memberships: [],
      assignments: {},
      emailByUserId: new Map(),
      userIdByEmail: new Map(),
      agentsById: new Map(),
      now: NOW,
    });
    plan.mapUpserts.push(assignment({ email: "Lucy@SeasonArt.org", agentId: "agent-9" }));

    expect(applyPlanToAssignments(before, plan)["lucy@seasonart.org"].agentId).toBe("agent-9");
  });

  it("does not mutate its input", () => {
    const before = { "lucy@seasonart.org": assignment() };
    const snapshot = JSON.parse(JSON.stringify(before));
    const plan = run({ memberships: [membership()], assignments: {} });
    applyPlanToAssignments(before, plan);

    expect(before).toEqual(snapshot);
  });
});
