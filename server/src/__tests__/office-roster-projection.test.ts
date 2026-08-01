import { describe, expect, it } from "vitest";
import {
  OFFICE_METADATA_KEYS,
  leaderboardDisplayName,
  redactForRosterView,
  scopeAgentKeyedRecord,
  type RosterAgentInput,
} from "../services/agent-roster-projection.js";

/**
 * The Virtual Office roster is the only agent listing with no visibility
 * filter, so under PAPERCLIP_RESTRICT_AGENT_VISIBILITY a member who can
 * otherwise see only their own agent still receives every agent from here.
 * That is deliberate — the office floor must be populated — which makes the
 * field list a security boundary rather than a display detail.
 */
const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  lastHeartbeatAt: new Date("2026-08-01T00:00:00.000Z"),
  pauseReason: null,
  errorReason: null,
  capabilities: ["build"],
  metadata: { teams: ["A"], officeCharacterId: "c1", salaryBand: "L5", privateNote: "do not publish" },
  // Fields that must NOT survive the projection. Typed loosely because the real
  // row carries them and the allowlist is what keeps them out.
  reportsTo: "manager-agent",
  budgetMonthlyCents: 500_000,
  spentMonthlyCents: 123_456,
  permissions: { canCreateAgents: true },
  adapterType: "process",
  adapterConfig: { assignedUserEmail: "owner@seasonart.org", apiKey: "secret" },
  runtimeConfig: { model: "opus" },
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
} as unknown as RosterAgentInput;

const view = () => redactForRosterView(agent) as Record<string, unknown>;

describe("office roster projection", () => {
  it("returns what the office floor renders", () => {
    expect(view()).toMatchObject({
      id: "agent-1",
      name: "Builder",
      role: "engineer",
      title: "Builder",
      status: "idle",
      capabilities: ["build"],
    });
  });

  // Spend is not display data. Before this became an allowlist it was published
  // to every member of the company.
  it.each(["budgetMonthlyCents", "spentMonthlyCents", "permissions", "adapterType", "createdAt", "updatedAt"])(
    "does not publish %s",
    (field) => {
      expect(view()).not.toHaveProperty(field);
    },
  );

  // The reporting chain lets any member reconstruct the org hierarchy that
  // restricted visibility exists to scope.
  it("does not publish the reporting chain", () => {
    expect(view()).not.toHaveProperty("reportsTo");
  });

  it("never leaks adapter or runtime config", () => {
    const entry = view();

    expect(entry.adapterConfig).toEqual({});
    expect(entry.runtimeConfig).toEqual({});
    expect(JSON.stringify(entry)).not.toContain("secret");
    expect(JSON.stringify(entry)).not.toContain("owner@seasonart.org");
  });

  it("passes through only the office metadata keys", () => {
    const entry = view();

    expect(entry.metadata).toEqual({ teams: ["A"], officeCharacterId: "c1" });
    expect(JSON.stringify(entry)).not.toContain("salaryBand");
    expect(JSON.stringify(entry)).not.toContain("do not publish");
  });

  it("drops metadata entirely when it is not an object", () => {
    expect(redactForRosterView({ ...agent, metadata: "nope" })?.metadata).toEqual({});
    expect(redactForRosterView({ ...agent, metadata: null })?.metadata).toEqual({});
  });

  it("keeps the office metadata allowlist to the keys the floor renders", () => {
    expect([...OFFICE_METADATA_KEYS]).toEqual(["teams", "team", "officeCharacterId", "officeAvatarUrl"]);
  });

  it("returns null for a missing agent", () => {
    expect(redactForRosterView(null)).toBeNull();
    expect(redactForRosterView(undefined)).toBeNull();
  });

  // An allowlist's whole point: a new column must not publish itself. This
  // fails when a field is added without a decision about who may see it.
  it("publishes an exact, reviewed field set", () => {
    expect(Object.keys(view()).sort()).toEqual([
      "adapterConfig",
      "capabilities",
      "companyId",
      "errorReason",
      "icon",
      "id",
      "lastHeartbeatAt",
      "metadata",
      "name",
      "pauseReason",
      "role",
      "runtimeConfig",
      "status",
      "title",
      "urlKey",
    ]);
  });
});

describe("scopeAgentKeyedRecord", () => {
  const counts = { "agent-mine": 3, "agent-theirs": 7, "agent-other": 1 };

  it("keeps only the agents the caller may see", () => {
    expect(scopeAgentKeyedRecord(counts, new Set(["agent-mine"]))).toEqual({ "agent-mine": 3 });
  });

  it("returns everything for an unrestricted caller", () => {
    expect(scopeAgentKeyedRecord(counts, null)).toEqual(counts);
  });

  // The distinction that matters: a member with no agents legitimately has an
  // empty set, and treating that as unrestricted would publish the company to
  // exactly the people the visibility flag exists to scope.
  it("returns nothing for an empty set, never everything", () => {
    expect(scopeAgentKeyedRecord(counts, new Set())).toEqual({});
  });

  it("ignores visible ids that are not in the record", () => {
    expect(scopeAgentKeyedRecord(counts, new Set(["agent-mine", "agent-gone"]))).toEqual({ "agent-mine": 3 });
  });

  it("does not mutate the input", () => {
    const snapshot = { ...counts };
    scopeAgentKeyedRecord(counts, new Set(["agent-mine"]));

    expect(counts).toEqual(snapshot);
  });
});

describe("leaderboardDisplayName", () => {
  it("prefers the display name", () => {
    expect(leaderboardDisplayName({ name: "Lucy", email: "lucy@seasonart.org" }, "user-1")).toBe("Lucy");
  });

  // The leaderboard is shown to every member; falling back to the raw address
  // turned a scoreboard into a company address list.
  it("falls back to the email local part, never the full address", () => {
    const shown = leaderboardDisplayName({ name: null, email: "lucy@seasonart.org" }, "user-1");

    expect(shown).toBe("lucy");
    expect(shown).not.toContain("@");
  });

  it("trims a blank name rather than showing whitespace", () => {
    expect(leaderboardDisplayName({ name: "   ", email: "lucy@seasonart.org" }, "user-1")).toBe("lucy");
  });

  it("falls back to a short id when there is nothing else", () => {
    expect(leaderboardDisplayName({ name: null, email: null }, "user-12345678901")).toBe("user-123");
    expect(leaderboardDisplayName(undefined, "user-12345678901")).toBe("user-123");
  });

  it("never returns an empty label", () => {
    expect(leaderboardDisplayName({ name: "", email: "@seasonart.org" }, "user-12345678").length).toBeGreaterThan(0);
  });
});
