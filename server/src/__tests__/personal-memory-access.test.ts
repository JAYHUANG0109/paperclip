import { describe, expect, it } from "vitest";
import {
  canReadPersonalMemory,
  canWritePersonalMemory,
  readableMemoryOwnerIds,
  resolveAgentMappedUserId,
  type MemoryRequester,
} from "../services/personal-memory-access.js";

const MEMBER = "user-member";
const CAMPUS_HEAD = "user-campus-head";
const owner = { ownerUserId: MEMBER };

const asMember: MemoryRequester = { kind: "user", userId: MEMBER };
const asCampusHead: MemoryRequester = { kind: "user", userId: CAMPUS_HEAD };
const asAdmin: MemoryRequester = { kind: "user", userId: "user-admin", isAdmin: true };
const memberAgent: MemoryRequester = { kind: "agent", agentId: "agent-1", mappedUserId: MEMBER };

describe("canReadPersonalMemory", () => {
  it("lets the owner read their own memory", () => {
    expect(canReadPersonalMemory(owner, asMember)).toBe(true);
  });

  it("lets an admin read it", () => {
    expect(canReadPersonalMemory(owner, asAdmin)).toBe(true);
  });

  it("refuses an unrelated user", () => {
    expect(canReadPersonalMemory(owner, asCampusHead)).toBe(false);
  });

  it("lets the agent mapped to the owner read it", () => {
    expect(canReadPersonalMemory(owner, memberAgent)).toBe(true);
  });

  it("refuses an agent mapped to someone else", () => {
    expect(
      canReadPersonalMemory(owner, { kind: "agent", agentId: "agent-2", mappedUserId: CAMPUS_HEAD }),
    ).toBe(false);
  });

  it("refuses an agent with no mapping", () => {
    expect(canReadPersonalMemory(owner, { kind: "agent", agentId: "agent-3", mappedUserId: null })).toBe(
      false,
    );
  });

  it("refuses when the owner id is empty", () => {
    expect(canReadPersonalMemory({ ownerUserId: "" }, asAdmin)).toBe(false);
  });

  // An agent is not an admin, and an admin driving it does not make it one.
  it("gives an agent no admin escape hatch", () => {
    const agentDrivenByAdmin = {
      kind: "agent",
      agentId: "agent-9",
      mappedUserId: null,
      isAdmin: true,
    } as unknown as MemoryRequester;

    expect(canReadPersonalMemory(owner, agentDrivenByAdmin)).toBe(false);
  });
});

// The scenario the whole module exists for.
describe("an agent follows its mapped user, not whoever is driving it", () => {
  it("reads the member's memory when the campus head opens the member's agent", () => {
    // The campus head is acting; the agent is the member's. The acting user is
    // not an input at all — there is nowhere to even pass them.
    expect(canReadPersonalMemory({ ownerUserId: MEMBER }, memberAgent)).toBe(true);
  });

  it("does not read the campus head's memory through the member's agent", () => {
    expect(canReadPersonalMemory({ ownerUserId: CAMPUS_HEAD }, memberAgent)).toBe(false);
  });

  it("does not leak an admin's own memory into someone else's agent", () => {
    expect(canReadPersonalMemory({ ownerUserId: "user-admin" }, memberAgent)).toBe(false);
  });

  // Guards the shape of the rule, not just its behaviour: if someone later adds
  // an acting-user field to the agent variant, this fails and asks why.
  it("has no acting-user field on the agent requester", () => {
    expect(Object.keys(memberAgent).sort()).toEqual(["agentId", "kind", "mappedUserId"]);
  });
});

describe("canWritePersonalMemory", () => {
  it("lets the owner write", () => {
    expect(canWritePersonalMemory(owner, asMember)).toBe(true);
  });

  it("lets the owner's agent write", () => {
    expect(canWritePersonalMemory(owner, memberAgent)).toBe(true);
  });

  // Admins read; they do not rewrite how someone's agent thinks.
  it("refuses an admin", () => {
    expect(canWritePersonalMemory(owner, asAdmin)).toBe(false);
    expect(canReadPersonalMemory(owner, asAdmin)).toBe(true);
  });

  it("refuses an unrelated user and an unrelated agent", () => {
    expect(canWritePersonalMemory(owner, asCampusHead)).toBe(false);
    expect(
      canWritePersonalMemory(owner, { kind: "agent", agentId: "agent-2", mappedUserId: CAMPUS_HEAD }),
    ).toBe(false);
  });
});

describe("resolveAgentMappedUserId", () => {
  const rows = [
    { agentId: "agent-1", userId: MEMBER, state: "joined" },
    { agentId: "agent-2", userId: CAMPUS_HEAD, state: "joined" },
  ];

  it("resolves the single mapped user", () => {
    expect(resolveAgentMappedUserId(rows, "agent-1")).toBe(MEMBER);
  });

  it("returns null for an agent with no mapping", () => {
    expect(resolveAgentMappedUserId(rows, "agent-unmapped")).toBeNull();
  });

  // Picking one would quietly expose one person's memory to another's agent.
  it("fails closed when an agent is shared between users", () => {
    const shared = [
      { agentId: "agent-1", userId: MEMBER, state: "joined" },
      { agentId: "agent-1", userId: CAMPUS_HEAD, state: "joined" },
    ];

    expect(resolveAgentMappedUserId(shared, "agent-1")).toBeNull();
  });

  it("tolerates duplicate rows for the same user", () => {
    const duplicated = [
      { agentId: "agent-1", userId: MEMBER, state: "joined" },
      { agentId: "agent-1", userId: MEMBER, state: "joined" },
    ];

    expect(resolveAgentMappedUserId(duplicated, "agent-1")).toBe(MEMBER);
  });

  it("ignores memberships that are not joined", () => {
    const pending = [{ agentId: "agent-1", userId: MEMBER, state: "pending" }];

    expect(resolveAgentMappedUserId(pending, "agent-1")).toBeNull();
  });

  it("treats a missing state as joined, for callers that do not select it", () => {
    expect(resolveAgentMappedUserId([{ agentId: "agent-1", userId: MEMBER }], "agent-1")).toBe(MEMBER);
  });

  it("feeds straight into the access check", () => {
    const mappedUserId = resolveAgentMappedUserId(rows, "agent-1");

    expect(canReadPersonalMemory(owner, { kind: "agent", agentId: "agent-1", mappedUserId })).toBe(true);
  });
});

describe("readableMemoryOwnerIds", () => {
  it("returns just the user for an ordinary user", () => {
    expect(readableMemoryOwnerIds(asMember)).toEqual([MEMBER]);
  });

  // null means "no restriction" — callers must branch on it explicitly rather
  // than letting an empty array quietly mean the same thing.
  it("returns null for an admin, distinctly from an empty list", () => {
    expect(readableMemoryOwnerIds(asAdmin)).toBeNull();
  });

  it("returns just the mapped user for an agent", () => {
    expect(readableMemoryOwnerIds(memberAgent)).toEqual([MEMBER]);
  });

  it("returns an empty list — not null — for an unmapped agent", () => {
    expect(readableMemoryOwnerIds({ kind: "agent", agentId: "a", mappedUserId: null })).toEqual([]);
  });
});
