import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instanceRoot = { current: "" };

vi.mock("../home-paths.js", () => ({
  resolveUserMemoryDir: (input: { companyId: string; userId: string }) =>
    path.resolve(instanceRoot.current, "memory", input.companyId, input.userId),
}));

const { buildRunMemoryEnv, prepareRunMemory } = await import("../services/run-memory.js");

const COMPANY = "company-1";
const OWNER = "user-owner";
const AGENT = "agent-1";

type Row = Record<string, unknown>;

/**
 * Minimal db stub matching what the service issues: a field-projected select
 * for membership rows, and an unprojected select for memory rows.
 */
function createDb(memoryRows: Row[], membershipRows: Row[]) {
  return {
    select(fields?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(fields ? membershipRows : memoryRows);
            },
          };
        },
      };
    },
  } as never;
}

function memory(overrides: Row = {}): Row {
  return {
    companyId: COMPANY,
    userId: OWNER,
    name: "likes-dark-mode",
    description: "a preference",
    memoryType: "user",
    content: "Prefers dark mode.",
    source: "manual",
    filePath: null,
    isBinary: false,
    ...overrides,
  };
}

beforeEach(async () => {
  instanceRoot.current = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-memory-"));
});

afterEach(async () => {
  await fs.rm(instanceRoot.current, { recursive: true, force: true });
});

describe("prepareRunMemory", () => {
  it("materializes the agent's mapped user's memory", async () => {
    const db = createDb([memory()], [{ agentId: AGENT, userId: OWNER, state: "joined" }]);

    const result = await prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT });

    expect(result).not.toBeNull();
    expect(result!.userId).toBe(OWNER);
    expect(result!.entryCount).toBe(1);
    expect(result!.dir).toBe(path.resolve(instanceRoot.current, "memory", COMPANY, OWNER));
    await expect(fs.readFile(result!.indexPath, "utf8")).resolves.toContain("likes-dark-mode");
  });

  // The rule this whole feature exists to enforce. An agent mapped to one user
  // gets that user's memory regardless of who woke the run — there is no
  // acting-user parameter to get wrong.
  it("follows the mapping, not whoever triggered the run", async () => {
    const db = createDb(
      [memory({ userId: OWNER, content: "Member's fact." })],
      [{ agentId: AGENT, userId: OWNER, state: "joined" }],
    );

    const result = await prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT });

    expect(result!.userId).toBe(OWNER);
    // prepareRunMemory accepts no acting user at all — assert the shape so a
    // future signature change that adds one has to break this test first.
    expect(prepareRunMemory.length).toBe(2);
  });

  // Ambiguity fails closed: two mapped users means no unambiguous owner, and
  // picking either would leak one person's memory into another's agent.
  it("gives no memory to an agent mapped to more than one user", async () => {
    const db = createDb(
      [memory()],
      [
        { agentId: AGENT, userId: OWNER, state: "joined" },
        { agentId: AGENT, userId: "user-other", state: "joined" },
      ],
    );

    await expect(prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT })).resolves.toBeNull();
  });

  it("gives no memory to an unmapped agent", async () => {
    const db = createDb([memory()], []);

    await expect(prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT })).resolves.toBeNull();
  });

  // A pending invite is not a mapping.
  it("ignores memberships that are not joined", async () => {
    const db = createDb([memory()], [{ agentId: AGENT, userId: OWNER, state: "invited" }]);

    await expect(prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT })).resolves.toBeNull();
  });

  // A mapped user with nothing stored still gets a directory and an index, so
  // the agent finds an empty memory rather than a missing path.
  it("returns an empty directory when the user has stored nothing", async () => {
    const db = createDb([], [{ agentId: AGENT, userId: OWNER, state: "joined" }]);

    const result = await prepareRunMemory(db, { companyId: COMPANY, agentId: AGENT });

    expect(result!.entryCount).toBe(0);
    await expect(fs.readFile(result!.indexPath, "utf8")).resolves.toContain("# Memory");
  });
});

describe("buildRunMemoryEnv", () => {
  it("describes the directory, index, and owner", () => {
    const env = buildRunMemoryEnv({
      dir: "/instance/memory/company-1/user-owner",
      userId: OWNER,
      indexPath: "/instance/memory/company-1/user-owner/MEMORY.md",
      entryCount: 2,
    });

    expect(env).toEqual({
      PAPERCLIP_MEMORY_DIR: "/instance/memory/company-1/user-owner",
      PAPERCLIP_MEMORY_INDEX: "/instance/memory/company-1/user-owner/MEMORY.md",
      PAPERCLIP_MEMORY_USER_ID: OWNER,
    });
  });

  // Every key is PAPERCLIP_-prefixed, which is what makes it a runtime var the
  // harness owns: adapters let those win over any same-named user binding.
  it("emits only harness-owned runtime keys", () => {
    const env = buildRunMemoryEnv({
      dir: "/d",
      userId: OWNER,
      indexPath: "/d/MEMORY.md",
      entryCount: 0,
    });

    for (const key of Object.keys(env)) expect(key.startsWith("PAPERCLIP_")).toBe(true);
  });
});
