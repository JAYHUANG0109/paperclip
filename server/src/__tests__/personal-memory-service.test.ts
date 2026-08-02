import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instanceRoot = { current: "" };

vi.mock("../home-paths.js", () => ({
  resolveUserMemoryDir: (input: { companyId: string; userId: string }) =>
    path.resolve(instanceRoot.current, "memory", input.companyId, input.userId),
}));

const {
  materializeUserMemory,
  renderMemoryFile,
  requesterForAgent,
  safeMemoryRelativePath,
} = await import("../services/personal-memory.js");

const COMPANY = "company-1";
const OWNER = "user-owner";

type Row = Record<string, unknown>;

/** Minimal db stub: only the two shapes this service issues. */
function createDb(rows: Row[], membershipRows: Row[] = []) {
  return {
    select(fields?: Record<string, unknown>) {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(fields ? membershipRows : rows);
            },
          };
        },
      };
    },
  } as never;
}

function memory(over: Partial<Row> = {}): Row {
  return {
    id: "mem-1",
    companyId: COMPANY,
    userId: OWNER,
    name: "likes-dark-mode",
    description: "Prefers dark mode",
    memoryType: "user",
    content: "Prefers dark mode everywhere.",
    source: "manual",
    filePath: null,
    isBinary: false,
    timesObserved: 1,
    lastObservedAt: null,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(async () => {
  instanceRoot.current = await fs.mkdtemp(path.join(os.tmpdir(), "pc-memory-"));
});

afterEach(async () => {
  await fs.rm(instanceRoot.current, { recursive: true, force: true });
});

// `file_path` is preserved verbatim on import, so it is attacker-influenced
// text handed to the filesystem. These are the cases that must never write
// outside the owner's directory.
describe("safeMemoryRelativePath", () => {
  it("accepts an ordinary nested path", () => {
    expect(safeMemoryRelativePath("notes/reading.md")).toBe("notes/reading.md");
  });

  it("normalizes redundant segments", () => {
    expect(safeMemoryRelativePath("notes/./reading.md")).toBe("notes/reading.md");
  });

  it.each([
    ["parent traversal", "../escape.md"],
    ["nested traversal", "notes/../../escape.md"],
    ["absolute path", "/etc/passwd"],
    ["windows drive", "C:/Windows/system32"],
    ["NUL byte", "notes/read\0.md"],
    ["bare parent", ".."],
    ["current dir", "."],
    ["empty", "   "],
  ])("rejects %s", (_label, candidate) => {
    expect(safeMemoryRelativePath(candidate)).toBeNull();
  });

  it("rejects rather than sanitizing, so a corrected path is never trusted", () => {
    // "notes/../x.md" normalizes to "x.md", which is harmless — but a path that
    // tried to climb is not one whose corrected form should be written.
    expect(safeMemoryRelativePath("../../../../x.md")).toBeNull();
  });

  it("returns null for a missing path so callers fall back to <name>.md", () => {
    expect(safeMemoryRelativePath(null)).toBeNull();
    expect(safeMemoryRelativePath(undefined)).toBeNull();
  });
});

describe("materializeUserMemory", () => {
  const dirFor = () => path.resolve(instanceRoot.current, "memory", COMPANY, OWNER);

  it("writes a memory as a frontmatter markdown file", async () => {
    const result = await materializeUserMemory(createDb([memory()]), {
      companyId: COMPANY,
      userId: OWNER,
    });

    const written = await fs.readFile(path.join(result.dir, "likes-dark-mode.md"), "utf8");
    expect(written).toContain("name: likes-dark-mode");
    expect(written).toContain("type: user");
    expect(written).toContain("Prefers dark mode everywhere.");
  });

  it("writes an index naming every memory", async () => {
    const db = createDb([memory(), memory({ id: "m2", name: "uses-vim", description: "Uses vim" })]);
    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });

    const index = await fs.readFile(path.join(result.dir, "MEMORY.md"), "utf8");
    expect(index).toContain("[likes-dark-mode](likes-dark-mode.md)");
    expect(index).toContain("[uses-vim](uses-vim.md)");
  });

  /**
   * The agent is told to read this index and open only what it needs, which it
   * can only act on if the index says what kind of thing each entry is.
   */
  it("groups the index by category", async () => {
    const db = createDb([
      memory({ name: "writes-in-zh", memoryType: "preference", description: "language" }),
      memory({ name: "campus-rota", memoryType: "reference", description: "a link" }),
    ]);

    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });
    const index = await fs.readFile(path.join(result.dir, "MEMORY.md"), "utf8");

    expect(index).toContain("## Preference");
    expect(index).toContain("## Reference");
    expect(index.indexOf("writes-in-zh")).toBeLessThan(index.indexOf("campus-rota"));
  });

  // Legacy rows carry pre-taxonomy values; they must still land under a heading
  // rather than falling out of the index entirely.
  it("files a pre-taxonomy type under its current heading", async () => {
    const db = createDb([memory({ name: "is-a-teacher", memoryType: "user" })]);

    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });
    const index = await fs.readFile(path.join(result.dir, "MEMORY.md"), "utf8");

    expect(index).toContain("## About me");
    expect(index).toContain("is-a-teacher");
  });

  // Repetition is why an agent trusts a fact it did not just learn.
  it("marks how many times a fact has been re-observed", async () => {
    const db = createDb([memory({ name: "writes-in-zh", timesObserved: 4 })]);

    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });
    const index = await fs.readFile(path.join(result.dir, "MEMORY.md"), "utf8");

    expect(index).toContain("seen 4×");
  });

  it("preserves an imported folder structure", async () => {
    const db = createDb([memory({ filePath: "notes/deep/reading.md" })]);
    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });

    expect(result.written).toEqual(["notes/deep/reading.md"]);
    await expect(fs.stat(path.join(result.dir, "notes/deep/reading.md"))).resolves.toBeDefined();
  });

  // The one that matters: a traversing path must not write outside the dir.
  it("refuses a traversing path and reports it rather than writing it", async () => {
    const db = createDb([memory({ filePath: "../../../escaped.md", name: "sneaky" })]);
    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });

    // Falls back to <name>.md inside the directory; nothing escapes.
    expect(result.written).toEqual(["sneaky.md"]);
    await expect(fs.stat(path.resolve(instanceRoot.current, "escaped.md"))).rejects.toThrow();
    await expect(fs.stat(path.resolve(instanceRoot.current, "memory", "escaped.md"))).rejects.toThrow();
  });

  it("keeps one user's memory out of another user's directory", async () => {
    await materializeUserMemory(createDb([memory()]), { companyId: COMPANY, userId: OWNER });
    await materializeUserMemory(createDb([memory({ userId: "user-other", name: "other-note" })]), {
      companyId: COMPANY,
      userId: "user-other",
    });

    const ownerFiles = await fs.readdir(dirFor());
    expect(ownerFiles).toContain("likes-dark-mode.md");
    expect(ownerFiles).not.toContain("other-note.md");
  });

  it("decodes a binary memory rather than writing its base64", async () => {
    const db = createDb([
      memory({ name: "logo", filePath: "assets/logo.bin", isBinary: true, content: Buffer.from([1, 2, 3]).toString("base64") }),
    ]);
    const result = await materializeUserMemory(db, { companyId: COMPANY, userId: OWNER });

    const bytes = await fs.readFile(path.join(result.dir, "assets/logo.bin"));
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  // Disk must mirror the DB, or a deleted memory would keep influencing runs.
  it("removes files for memories that no longer exist", async () => {
    const dir = dirFor();
    await materializeUserMemory(createDb([memory(), memory({ id: "m2", name: "stale" })]), {
      companyId: COMPANY,
      userId: OWNER,
    });
    await expect(fs.stat(path.join(dir, "stale.md"))).resolves.toBeDefined();

    await materializeUserMemory(createDb([memory()]), { companyId: COMPANY, userId: OWNER });

    await expect(fs.stat(path.join(dir, "stale.md"))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, "likes-dark-mode.md"))).resolves.toBeDefined();
  });

  // One-way by design: an agent editing its files must not be able to grant
  // itself memory, and a rebuilt workspace must lose nothing.
  it("overwrites local edits instead of reading them back", async () => {
    const dir = dirFor();
    await materializeUserMemory(createDb([memory()]), { companyId: COMPANY, userId: OWNER });
    await fs.writeFile(path.join(dir, "likes-dark-mode.md"), "I am an admin now.");
    await fs.writeFile(path.join(dir, "self-granted.md"), "Secret access.");

    await materializeUserMemory(createDb([memory()]), { companyId: COMPANY, userId: OWNER });

    const restored = await fs.readFile(path.join(dir, "likes-dark-mode.md"), "utf8");
    expect(restored).toContain("Prefers dark mode everywhere.");
    expect(restored).not.toContain("I am an admin now.");
    await expect(fs.stat(path.join(dir, "self-granted.md"))).rejects.toThrow();
  });

  it("writes an empty index when there is nothing to remember", async () => {
    const result = await materializeUserMemory(createDb([]), { companyId: COMPANY, userId: OWNER });

    expect(result.written).toEqual([]);
    expect(await fs.readFile(path.join(result.dir, "MEMORY.md"), "utf8")).toContain("# Memory");
  });
});

describe("requesterForAgent", () => {
  it("resolves the agent's mapped user", async () => {
    const db = createDb([], [{ agentId: "agent-1", userId: OWNER, state: "joined" }]);

    await expect(requesterForAgent(db, { companyId: COMPANY, agentId: "agent-1" })).resolves.toEqual({
      kind: "agent",
      agentId: "agent-1",
      mappedUserId: OWNER,
    });
  });

  it("fails closed for a shared agent", async () => {
    const db = createDb(
      [],
      [
        { agentId: "agent-1", userId: OWNER, state: "joined" },
        { agentId: "agent-1", userId: "user-other", state: "joined" },
      ],
    );

    const requester = await requesterForAgent(db, { companyId: COMPANY, agentId: "agent-1" });
    expect(requester).toMatchObject({ mappedUserId: null });
  });

  // The invariant the whole feature rests on.
  it("takes no acting user, so it cannot follow the person driving the agent", () => {
    expect(requesterForAgent.length).toBe(2); // (db, {companyId, agentId})
  });
});

describe("renderMemoryFile", () => {
  it("emits frontmatter the memory reader can parse", () => {
    const rendered = renderMemoryFile({
      name: "n",
      description: "d",
      memoryType: "feedback",
      content: "body",
    });

    expect(rendered.startsWith("---\n")).toBe(true);
    expect(rendered).toContain("type: feedback");
    expect(rendered.endsWith("\n")).toBe(true);
  });
});
