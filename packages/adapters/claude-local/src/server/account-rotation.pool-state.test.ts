import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import {
  chooseClaudeAccountDirForRun,
  describeClaudeAccountPool,
  markClaudeAccountCoolingDown,
  mergeClaudeAccountPools,
  resetClaudeAccountRotationStateForTests,
  resolveClaudeAccountIdentity,
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
    expect(describeClaudeAccountPool([])).toEqual({ activeDir: null, entries: [] });
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
