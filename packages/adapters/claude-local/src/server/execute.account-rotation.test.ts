import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { parseClaudeAccountConfigDirs, selectHealthyClaudeAccountDir } from "./execute.js";

describe("parseClaudeAccountConfigDirs", () => {
  it("splits on newlines, commas, and semicolons, resolves, and dedupes", () => {
    const dirs = parseClaudeAccountConfigDirs("/a/one, /a/two\n/a/three ; /a/one");
    expect(dirs).toEqual([path.resolve("/a/one"), path.resolve("/a/two"), path.resolve("/a/three")]);
  });

  it("expands a leading ~ to the home directory", () => {
    const dirs = parseClaudeAccountConfigDirs("~/.claude-accounts/acct1");
    expect(dirs).toEqual([path.join(os.homedir(), ".claude-accounts", "acct1")]);
  });

  it("returns an empty list for non-strings / blank input", () => {
    expect(parseClaudeAccountConfigDirs(undefined)).toEqual([]);
    expect(parseClaudeAccountConfigDirs("")).toEqual([]);
    expect(parseClaudeAccountConfigDirs("  ,, ; \n ")).toEqual([]);
  });
});

describe("selectHealthyClaudeAccountDir", () => {
  const pool = ["/acct/a", "/acct/b", "/acct/c"];

  it("returns null when the pool is empty", async () => {
    const res = await selectHealthyClaudeAccountDir({
      pool: [],
      thresholdPercent: 95,
      activeDir: null,
      probeUsedPercent: async () => 0,
    });
    expect(res).toBeNull();
  });

  it("sticks with the active account while it is under threshold", async () => {
    const res = await selectHealthyClaudeAccountDir({
      pool,
      thresholdPercent: 95,
      activeDir: "/acct/b",
      probeUsedPercent: async (dir) => (dir === "/acct/b" ? 40 : 0),
    });
    expect(res).toMatchObject({ dir: "/acct/b", usedPercent: 40, rotated: false, exhausted: false });
  });

  it("rotates to the next healthy account when the active one crosses threshold", async () => {
    const used: Record<string, number> = { "/acct/a": 97, "/acct/b": 20, "/acct/c": 10 };
    const res = await selectHealthyClaudeAccountDir({
      pool,
      thresholdPercent: 95,
      activeDir: "/acct/a",
      probeUsedPercent: async (dir) => used[dir] ?? null,
    });
    expect(res).toMatchObject({ dir: "/acct/b", rotated: true, exhausted: false });
  });

  it("wraps around so an earlier reset account becomes reusable", async () => {
    // Active is the last account and it's full; the first account has reset.
    const used: Record<string, number> = { "/acct/a": 5, "/acct/b": 99, "/acct/c": 98 };
    const res = await selectHealthyClaudeAccountDir({
      pool,
      thresholdPercent: 95,
      activeDir: "/acct/c",
      probeUsedPercent: async (dir) => used[dir] ?? null,
    });
    expect(res).toMatchObject({ dir: "/acct/a", rotated: true });
  });

  it("prefers an account with unreadable quota over a known-full one", async () => {
    const used: Record<string, number | null> = { "/acct/a": 99, "/acct/b": null, "/acct/c": 99 };
    const res = await selectHealthyClaudeAccountDir({
      pool,
      thresholdPercent: 95,
      activeDir: "/acct/a",
      probeUsedPercent: async (dir) => used[dir] ?? null,
    });
    expect(res).toMatchObject({ dir: "/acct/b", usedPercent: null, exhausted: false });
  });

  it("marks exhausted and sticks with the start account when every account is full", async () => {
    const res = await selectHealthyClaudeAccountDir({
      pool,
      thresholdPercent: 95,
      activeDir: "/acct/b",
      probeUsedPercent: async () => 99,
    });
    expect(res).toMatchObject({ dir: "/acct/b", rotated: false, exhausted: true });
  });

  it("treats a failing probe as unknown quota, not a crash", async () => {
    const res = await selectHealthyClaudeAccountDir({
      pool: ["/acct/a", "/acct/b"],
      thresholdPercent: 95,
      activeDir: null,
      probeUsedPercent: async (dir) => {
        if (dir === "/acct/a") throw new Error("cli exploded");
        return 10;
      },
    });
    // /acct/a throws → unknown; /acct/b is healthy → picked.
    expect(res).toMatchObject({ dir: "/acct/b", usedPercent: 10 });
  });
});
