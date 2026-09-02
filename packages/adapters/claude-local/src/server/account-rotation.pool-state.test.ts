import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Selection reads live usage per dir; these cases are about pool STATE, so keep
// them hermetic (no keychain, no network). Unreadable usage is also the honest
// default for fake dirs like /acct/a. Usage-driven selection is covered in
// account-rotation.proactive.test.ts.
vi.mock("./quota.js", () => ({ fetchClaudeQuotaForConfigDir: vi.fn(async () => null) }));

import {
  chooseClaudeAccountDirForRun,
  describeClaudeAccountPool,
  getPinnedClaudeAccountDir,
  markClaudeAccountCoolingDown,
  mergeClaudeAccountPools,
  resetClaudeAccountRotationStateForTests,
  resolveClaudeAccountIdentity,
  setPinnedClaudeAccountDir,
  type ClaudeAccountIdentity,
} from "./account-rotation.js";

const A = path.resolve("/acct/a");
const B = path.resolve("/acct/b");
const C = path.resolve("/acct/c");

beforeEach(() => {
  resetClaudeAccountRotationStateForTests();
});

describe("mergeClaudeAccountPools", () => {
  it("merges the pools configured across agents, de-duplicating in first-seen order", () => {
    expect(mergeClaudeAccountPools([
      "/acct/a, /acct/b",
      "/acct/b, /acct/c",
    ])).toEqual([A, B, C]);
  });

  it("ignores blank and non-string pools", () => {
    expect(mergeClaudeAccountPools(["", "   ", "/acct/a"])).toEqual([A]);
    expect(mergeClaudeAccountPools([])).toEqual([]);
  });
});

describe("describeClaudeAccountPool", () => {
  it("reports no resolved active dir before any run, but still marks the pool head", () => {
    const state = describeClaudeAccountPool([A, B, C]);
    expect(state.activeDir).toBeNull();
    expect(state.entries.map((e) => e.active)).toEqual([true, false, false]);
  });

  it("marks the account a run actually settled on", async () => {
    await chooseClaudeAccountDirForRun({ config: { claudeAccountConfigDirs: "/acct/a, /acct/b" } });
    const state = describeClaudeAccountPool([A, B]);
    expect(state.activeDir).toBe(A);
    expect(state.entries.find((e) => e.dir === A)?.active).toBe(true);
  });

  it("surfaces the cooldown reset time for a quota-limited account", () => {
    const until = Date.now() + 45 * 60 * 1000;
    markClaudeAccountCoolingDown(B, until);
    const state = describeClaudeAccountPool([A, B]);
    expect(state.entries.find((e) => e.dir === A)?.coolingDownUntil).toBeNull();
    expect(state.entries.find((e) => e.dir === B)?.coolingDownUntil).toBe(
      new Date(until).toISOString(),
    );
  });

  it("stops reporting a cooldown once its window has passed", () => {
    markClaudeAccountCoolingDown(B, Date.now() + 1_000);
    const later = Date.now() + 60_000;
    const state = describeClaudeAccountPool([A, B], later);
    expect(state.entries.find((e) => e.dir === B)?.coolingDownUntil).toBeNull();
  });

  it("returns an empty pool unchanged", () => {
    expect(describeClaudeAccountPool([])).toEqual({ activeDir: null, pinnedDir: null, entries: [] });
  });
});

// An operator pin is a PREFERENCE, not an override: preferred while healthy,
// walked past while quota-limited so agents keep working, and resumed the moment
// its window resets. These pin that contract.
describe("pinned account", () => {
  const config = { claudeAccountConfigDirs: "/acct/a, /acct/b, /acct/c" };
  let pinFile: string;

  beforeEach(() => {
    pinFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pin-")),
      "claude-account-pin.json",
    );
    process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE = pinFile;
    resetClaudeAccountRotationStateForTests();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE;
  });

  it("sends runs to the pinned account instead of the pool head", async () => {
    setPinnedClaudeAccountDir(C);
    const chosen = await chooseClaudeAccountDirForRun({ config });
    expect(chosen?.selection.dir).toBe(C);
  });

  it("persists the pin so it survives a restart", async () => {
    expect(setPinnedClaudeAccountDir(B).persisted).toBe(true);
    // Simulate a fresh process: state cleared, same pin file on disk.
    resetClaudeAccountRotationStateForTests();
    expect(getPinnedClaudeAccountDir()).toBe(B);
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(B);
  });

  it("walks past a quota-limited pin so agents keep working", async () => {
    setPinnedClaudeAccountDir(B);
    markClaudeAccountCoolingDown(B, Date.now() + 60 * 60 * 1000);
    const chosen = await chooseClaudeAccountDirForRun({ config });
    expect(chosen?.selection.dir).toBe(C);
    // The pin itself is untouched — it is a preference, not a one-shot.
    expect(getPinnedClaudeAccountDir()).toBe(B);
  });

  it("returns to the pin once its quota window resets", async () => {
    setPinnedClaudeAccountDir(B);
    markClaudeAccountCoolingDown(B, Date.now() + 1_000);
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(C);
    // Cooldown expires; the walk restarts at the pin, so B is picked up again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(B);
  });

  it("clearing the pin returns to automatic rotation from the pool head", async () => {
    setPinnedClaudeAccountDir(C);
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(C);
    setPinnedClaudeAccountDir(null);
    expect(getPinnedClaudeAccountDir()).toBeNull();
    resetClaudeAccountRotationStateForTests();
    process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE = pinFile;
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);
  });

  it("ignores a pin naming a dir outside the pool", async () => {
    setPinnedClaudeAccountDir("/acct/not-in-pool");
    const chosen = await chooseClaudeAccountDirForRun({ config });
    expect(chosen?.selection.dir).toBe(A);
  });

  it("marks the pinned entry, and never shows a cooling pin as in use", () => {
    setPinnedClaudeAccountDir(B);
    let state = describeClaudeAccountPool([A, B, C]);
    expect(state.pinnedDir).toBe(B);
    expect(state.entries.find((e) => e.dir === B)?.pinned).toBe(true);
    expect(state.entries.find((e) => e.dir === B)?.active).toBe(true);

    markClaudeAccountCoolingDown(B, Date.now() + 60 * 60 * 1000);
    state = describeClaudeAccountPool([A, B, C]);
    expect(state.entries.find((e) => e.dir === B)?.pinned).toBe(true);
    expect(state.entries.find((e) => e.dir === B)?.active).toBe(false);
    expect(state.entries.find((e) => e.active)?.dir).toBe(A);
  });

  it("reports not-persisted when no pin file is configured", () => {
    delete process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE;
    resetClaudeAccountRotationStateForTests();
    expect(setPinnedClaudeAccountDir(B).persisted).toBe(false);
    // Still applies to this process so the operator's click is not silently lost.
    expect(getPinnedClaudeAccountDir()).toBe(B);
  });
});

describe("resolveClaudeAccountIdentity", () => {
  const identity: ClaudeAccountIdentity = {
    email: "bot@example.com",
    subscriptionType: "team",
    orgName: "Example",
    loggedIn: true,
  };

  it("memoizes a successful read so a page refresh does not re-spawn the CLI", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return identity;
    };
    expect(await resolveClaudeAccountIdentity(A, read)).toEqual(identity);
    expect(await resolveClaudeAccountIdentity(A, read)).toEqual(identity);
    expect(calls).toBe(1);
  });

  it("re-reads once the cache entry has aged out", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return identity;
    };
    const t0 = 1_000_000;
    await resolveClaudeAccountIdentity(A, read, t0);
    await resolveClaudeAccountIdentity(A, read, t0 + 6 * 60 * 1000);
    expect(calls).toBe(2);
  });

  // A transient CLI failure must not pin "signed out" for the whole TTL —
  // otherwise one blip hides a healthy account for five minutes.
  it("does not cache a failed or logged-out read", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      return calls === 1 ? null : identity;
    };
    const first = await resolveClaudeAccountIdentity(A, flaky);
    expect(first.loggedIn).toBe(false);
    expect(first.email).toBeNull();
    expect((await resolveClaudeAccountIdentity(A, flaky)).email).toBe("bot@example.com");
  });

  it("treats a throwing reader as unknown rather than propagating", async () => {
    const boom = async () => {
      throw new Error("claude not on PATH");
    };
    expect(await resolveClaudeAccountIdentity(C, boom)).toEqual({
      email: null,
      subscriptionType: null,
      orgName: null,
      loggedIn: false,
    });
  });
});
