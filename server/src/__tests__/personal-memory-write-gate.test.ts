import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MEMORY_MAX_CONTENT_CHARS, AGENT_MEMORY_WRITES_PER_HOUR } from "@paperclipai/shared";

/**
 * The write gate — what `upsertPersonalMemory` refuses, and why.
 *
 * This is the test that matters most in this feature. Capture used to be a line
 * in the agent prompt asking for restraint, which is a request and enforces
 * nothing; these are the rules that hold whether or not the prompt lands. The
 * asymmetry between an agent writing and the owner writing is the point, so
 * most cases are asserted from both sides.
 */

const COMPANY = "company-1";
const OWNER = "user-owner";
const AGENT = "agent-owner";

const state = {
  /** Row returned for the "is there one under this slug?" lookup. */
  existingByName: null as Record<string, unknown> | null,
  /** Rows the content-duplicate scan sees. */
  dedupeCandidates: [] as Array<Record<string, unknown>>,
  /** What the rolling-hour count answers. */
  recentAgentWrites: 0,
  /** The owner's capture switch, as `getMemorySettings` would read it. */
  captureEnabled: true,
  inserted: [] as Array<Record<string, unknown>>,
  conflictUpdates: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
};

/**
 * Db stub that tells the read shapes apart WITHOUT inspecting SQL.
 *
 * They are already distinguishable by how the service builds them: the
 * projected queries (rolling-hour count, capture switch) pass a field map to
 * `select()` and are told apart by whether the caller ends in `.limit()`, the
 * by-name lookup ends in `.limit()`, and the duplicate scan awaits the `where()`
 * builder directly. Discriminating on shape keeps this stub honest — it breaks
 * loudly if the service starts issuing a query it does not model, rather than
 * quietly returning the wrong rows.
 */
function createDb() {
  return {
    select(fields?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              if (fields) {
                // Awaited directly → the count. Followed by `.limit()` → the
                // settings row. Both are projected, so only the shape separates them.
                const counted = Promise.resolve([{ count: state.recentAgentWrites }]);
                return Object.assign(counted, {
                  limit: () => Promise.resolve([{ captureEnabled: state.captureEnabled }]),
                });
              }
              const scan = Promise.resolve(state.dedupeCandidates);
              return Object.assign(scan, {
                limit: () => Promise.resolve(state.existingByName ? [state.existingByName] : []),
              });
            },
          };
        },
      };
    },
    insert() {
      return {
        values(values: Record<string, unknown>) {
          state.inserted.push(values);
          return {
            onConflictDoUpdate(config: { set: Record<string, unknown> }) {
              state.conflictUpdates.push(config.set);
              return {
                returning: () =>
                  Promise.resolve([{ ...values, timesObserved: 1, id: "row-1" }]),
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updated.push(values);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([{ ...(state.existingByName ?? {}), ...values, timesObserved: 2 }]),
            }),
          };
        },
      };
    },
  } as never;
}

vi.mock("../home-paths.js", () => ({
  resolveUserMemoryDir: () => "/tmp/unused",
}));

const { upsertPersonalMemory } = await import("../services/personal-memory.js");

const asAgent = { kind: "agent" as const, agentId: AGENT, mappedUserId: OWNER };
const asOwner = { kind: "user" as const, userId: OWNER, isAdmin: false };
const asOtherUser = { kind: "user" as const, userId: "user-other", isAdmin: false };

function write(requester: typeof asAgent | typeof asOwner, overrides: Record<string, unknown> = {}) {
  return upsertPersonalMemory(createDb(), {
    companyId: COMPANY,
    ownerUserId: OWNER,
    requester,
    name: "a-fact",
    content: "Prefers Traditional Chinese in written updates.",
    ...overrides,
  } as never);
}

beforeEach(() => {
  state.existingByName = null;
  state.dedupeCandidates = [];
  state.recentAgentWrites = 0;
  state.captureEnabled = true;
  state.inserted = [];
  state.conflictUpdates = [];
  state.updated = [];
});

describe("the owner's capture switch", () => {
  it("stops an agent writing while capture is paused", async () => {
    state.captureEnabled = false;

    const result = await write(asAgent);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("capture_paused");
    expect(state.inserted).toHaveLength(0);
  });

  // Pausing is about what gets INFERRED about you, not about your own notes.
  it("does not stop the owner writing their own memory", async () => {
    state.captureEnabled = false;

    const result = await write(asOwner);

    expect(result.ok).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  // The switch has to be checked before the content is, or a paused user still
  // learns which of their agents' writes would have been screened.
  it("is checked before screening, so a paused agent gets one answer", async () => {
    state.captureEnabled = false;

    const result = await write(asAgent, { content: "their password: hunter2hunter2" });

    expect(result.ok === false && result.reason).toBe("capture_paused");
  });
});

describe("names the API has reserved", () => {
  // /memories/{name} shares a namespace with /memories/stats and friends. The
  // clash is structural, so it is refused for everyone rather than left to
  // route-registration order.
  it.each(["stats", "settings", "deleted", "seed", "import", "restore"])(
    "refuses %s as a memory name",
    async (name) => {
      const result = await write(asOwner, { name });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("reserved_name");
      expect(state.inserted).toHaveLength(0);
    },
  );

  it("allows a name that merely contains a reserved word", async () => {
    const result = await write(asOwner, { name: "stats-dashboard-link" });

    expect(result.ok).toBe(true);
  });
});

describe("permission still comes first", () => {
  it("refuses a requester who may not write, without saying why", async () => {
    const result = await write(asOtherUser);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("forbidden");
    // "You may not write here" must stay indistinguishable from "no such owner".
    expect(result.ok === false && result.message).toBe("Memory not found");
    expect(state.inserted).toHaveLength(0);
  });
});

describe("screening on the way in", () => {
  it("refuses a secret from an agent", async () => {
    const result = await write(asAgent, { content: "their key is sk-abcdefghijklmnop0123" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("screened");
    expect(result.ok === false && result.screenClass).toBe("credential");
    expect(state.inserted).toHaveLength(0);
  });

  // Nobody opts out of this one: a stored secret is written to disk in a
  // workspace an agent reads.
  it("refuses a secret from the owner too", async () => {
    const result = await write(asOwner, { content: "password: hunter2hunter2" });

    expect(result.ok === false && result.screenClass).toBe("credential");
  });

  it("refuses an agent filing a health detail", async () => {
    const result = await write(asAgent, { content: "She was diagnosed with something in March." });

    expect(result.ok === false && result.screenClass).toBe("health");
  });

  // The difference is consent, and admins can read personal memory.
  it("lets the owner record the same health detail about themselves", async () => {
    const result = await write(asOwner, { content: "She was diagnosed with something in March." });

    expect(result.ok).toBe(true);
    expect(state.inserted).toHaveLength(1);
  });

  it("tells the writer which rule it broke", async () => {
    const result = await write(asAgent, { content: "Their salary is under review." });

    // A bare failure teaches an agent nothing and it retries identically.
    expect(result.ok === false && result.message).toMatch(/financial/i);
  });
});

describe("size ceilings", () => {
  it("refuses an over-long agent write", async () => {
    const result = await write(asAgent, { content: "x".repeat(AGENT_MEMORY_MAX_CONTENT_CHARS + 1) });

    expect(result.ok === false && result.reason).toBe("too_long");
    expect(result.ok === false && result.message).toMatch(/transcript/i);
  });

  it("does not cap what a person writes about themselves", async () => {
    const result = await write(asOwner, { content: "x".repeat(AGENT_MEMORY_MAX_CONTENT_CHARS + 1) });

    expect(result.ok).toBe(true);
  });
});

describe("the rolling cap on new entries", () => {
  it("refuses once an agent has filed the hour's allowance", async () => {
    state.recentAgentWrites = AGENT_MEMORY_WRITES_PER_HOUR;

    const result = await write(asAgent);

    expect(result.ok === false && result.reason).toBe("rate_limited");
    expect(state.inserted).toHaveLength(0);
  });

  // Revising a fact it already holds is the behaviour we want; it is the stream
  // of NEW entries that turns a memory into a log.
  it("still lets it revise an entry it already holds", async () => {
    state.recentAgentWrites = AGENT_MEMORY_WRITES_PER_HOUR + 5;
    state.existingByName = { id: "row-1", name: "a-fact", content: "older wording" };

    const result = await write(asAgent);

    expect(result.ok).toBe(true);
  });

  it("does not cap the owner", async () => {
    state.recentAgentWrites = AGENT_MEMORY_WRITES_PER_HOUR + 50;

    expect((await write(asOwner)).ok).toBe(true);
  });
});

describe("duplicates", () => {
  it("folds an agent's restatement into the entry that already says it", async () => {
    state.dedupeCandidates = [
      { id: "row-existing", name: "language", content: "prefers traditional chinese in written updates", timesObserved: 1 },
    ];

    const result = await write(asAgent, { name: "language-preference" });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.deduped).toBe(true);
    // Recognised, not stored twice under a second slug.
    expect(state.inserted).toHaveLength(0);
    expect(state.updated[0]).toMatchObject({ timesObserved: expect.anything() });
  });

  it("still stores a genuinely different fact", async () => {
    state.dedupeCandidates = [{ id: "row-existing", name: "other", content: "something else", timesObserved: 1 }];

    const result = await write(asAgent);

    expect(result.ok === true && result.deduped).toBe(false);
    expect(state.inserted).toHaveLength(1);
  });
});

describe("observation counting", () => {
  it("counts an agent arriving at a stored fact again", async () => {
    state.existingByName = { id: "row-1", name: "a-fact", content: "older wording" };

    await write(asAgent);

    expect(state.conflictUpdates[0]).toHaveProperty("timesObserved");
    expect(state.conflictUpdates[0]).toHaveProperty("lastObservedAt");
  });

  // An owner editing their own words is correcting it, not confirming it again;
  // counting that would make the number mean two different things.
  it("does not count the owner editing their own entry", async () => {
    state.existingByName = { id: "row-1", name: "a-fact", content: "older wording" };

    await write(asOwner);

    expect(state.conflictUpdates[0]).not.toHaveProperty("timesObserved");
  });
});

/**
 * The prompt quotes these numbers to the agent so a refusal is something it can
 * fix rather than retry. Nothing else ties the two together, so if the enforced
 * limit moves and the prompt does not, the agent is being told a falsehood by
 * the same system that then refuses it. This is the only place both sides are
 * visible at once.
 */
describe("the prompt and the gate agree", () => {
  it("quotes the enforced limits", async () => {
    const { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } = await import("@paperclipai/adapter-utils/server-utils");

    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(String(AGENT_MEMORY_MAX_CONTENT_CHARS));
    expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(String(AGENT_MEMORY_WRITES_PER_HOUR));
  });

  it("names the categories the API will actually accept", async () => {
    const { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } = await import("@paperclipai/adapter-utils/server-utils");
    const { MEMORY_CATEGORY_IDS } = await import("@paperclipai/shared");

    for (const id of MEMORY_CATEGORY_IDS) {
      expect(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE).toContain(`\`${id}\``);
    }
  });
});

describe("categories", () => {
  it("normalizes whatever the caller supplied", async () => {
    await write(asAgent, { memoryType: "Preferences" });

    expect(state.inserted[0]).toMatchObject({ memoryType: "preference" });
  });

  it("maps the pre-taxonomy value forward", async () => {
    await write(asOwner, { memoryType: "user" });

    expect(state.inserted[0]).toMatchObject({ memoryType: "profile" });
  });

  it("files an unlabelled memory under the default", async () => {
    await write(asOwner, {});

    expect(state.inserted[0]).toMatchObject({ memoryType: "project" });
  });
});
