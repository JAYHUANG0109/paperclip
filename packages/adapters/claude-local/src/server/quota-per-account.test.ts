import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * Per-account usage reads.
 *
 * Two properties matter more than the happy path. First, a keychain-backed host keeps
 * credentials OUTSIDE the config dir — there is no `.credentials.json` — so a token
 * lookup that only reads files silently returns nothing and every account shows blank.
 * Second, `/api/oauth/usage` is not a published API: when it moves, or a token has
 * expired, the answer must be null so callers render "unknown" rather than a 0% bar
 * that reads as "plenty of headroom left".
 */

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileMock };
});

/** Shape node:util.promisify(execFile) expects: cb(err, { stdout, stderr }). */
function keychainReturns(payload: string | null) {
  execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: unknown) => {
    const done = cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    if (payload == null) done(new Error("SecKeychainSearchCopyNext: not found"));
    else done(null, { stdout: payload, stderr: "" });
    return {} as never;
  });
}

const creds = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat-test",
      expiresAt: Date.now() + 3_600_000,
      subscriptionType: "max",
      ...over,
    },
  });

/** The keychain service a config dir owns — mirrors the production derivation. */
const ownService = (dir: string) =>
  `Claude Code-credentials-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;

const usageBody = {
  five_hour: { utilization: 81, resets_at: "2026-08-04T09:30:00.000Z" },
  seven_day: { utilization: 54, resets_at: "2026-08-04T23:00:00.000Z" },
};

let quota: typeof import("./quota.js");

beforeEach(async () => {
  vi.resetModules();
  execFileMock.mockReset();
  quota = await import("./quota.js");
  quota.resetClaudeQuotaCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClaudeQuotaForConfigDir", () => {
  it("reads the token from the Keychain when the config dir has no credential file", async () => {
    keychainReturns(creds());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(usageBody), { status: 200 })));

    const windows = await quota.fetchClaudeQuotaForConfigDir("/tmp/does-not-exist-acct2");

    expect(windows).not.toBeNull();
    expect(windows!.map((w) => w.usedPercent)).toEqual([81, 54]);
    // Must go through /usr/bin/security, whose ACL the item grants — a native binding
    // would prompt, and a prompt in a launchd service hangs forever.
    expect(execFileMock.mock.calls[0]?.[0]).toBe("/usr/bin/security");
  });

  it("derives a distinct keychain item per config dir, so accounts cannot cross-read", async () => {
    keychainReturns(creds());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(usageBody), { status: 200 })));

    await quota.fetchClaudeQuotaForConfigDir("/tmp/acct-a");
    await quota.fetchClaudeQuotaForConfigDir("/tmp/acct-b");

    const services = execFileMock.mock.calls.map((c) => (c[1] as string[])[2]);
    expect(services[0]).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(services[0]).not.toBe(services[1]);
  });

  it("returns null for an expired token instead of earning a 401", async () => {
    keychainReturns(creds({ expiresAt: Date.now() - 1_000 }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await quota.fetchClaudeQuotaForConfigDir("/tmp/expired")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null — never 0% — when the usage endpoint stops working", async () => {
    keychainReturns(creds());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));

    // The bar must disappear, not render as "0% used, plenty left".
    expect(await quota.fetchClaudeQuotaForConfigDir("/tmp/moved-endpoint")).toBeNull();
  });

  it("returns null when the account has no readable credentials", async () => {
    keychainReturns(null);
    vi.stubGlobal("fetch", vi.fn());

    expect(await quota.fetchClaudeQuotaForConfigDir("/tmp/logged-out")).toBeNull();
  });

  it("caches per dir so a page poll does not hit the Keychain and API each render", async () => {
    keychainReturns(creds());
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(usageBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await quota.fetchClaudeQuotaForConfigDir("/tmp/cached");
    await quota.fetchClaudeQuotaForConfigDir("/tmp/cached");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("caches failures too, so a logged-out account is not retried on every render", async () => {
    keychainReturns(null);
    vi.stubGlobal("fetch", vi.fn());

    await quota.fetchClaudeQuotaForConfigDir("/tmp/still-logged-out");
    await quota.fetchClaudeQuotaForConfigDir("/tmp/still-logged-out");

    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The legacy unsuffixed `Claude Code-credentials` item belongs to whichever
 * account was signed in before Claude Code namespaced credentials per config
 * dir — NOT necessarily to whoever owns ~/.claude today. Offering it to a dir
 * that has its own item is how one account's usage got reported under another
 * account's name: ~/.claude (bot_14) had merely an expired token, fell through,
 * and rendered bot_13's percentages.
 */
describe("legacy unsuffixed keychain item", () => {
  const hostDefaultDir = path.join(os.homedir(), ".claude");
  const LEGACY_SERVICE = "Claude Code-credentials";

  /** Per-service keychain: a payload, or `notFound` for errSecItemNotFound (exit 44). */
  function keychainByService(items: Record<string, string | "notFound">) {
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: unknown) => {
      const done = cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
      const entry = items[args[2] ?? ""] ?? "notFound";
      if (entry === "notFound") done(Object.assign(new Error("could not be found"), { code: 44 }));
      else done(null, { stdout: entry, stderr: "" });
      return {} as never;
    });
  }

  const servicesTried = () => execFileMock.mock.calls.map((c) => (c[1] as string[])[2]);

  it("is not consulted when the dir has its own item, even an expired one", async () => {
    keychainByService({
      [ownService(hostDefaultDir)]: creds({ expiresAt: Date.now() - 1_000 }),
      [LEGACY_SERVICE]: creds(),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // "No data" is the honest answer. Another account's numbers are not.
    expect(await quota.fetchClaudeQuotaForConfigDir(hostDefaultDir)).toBeNull();
    expect(servicesTried()).not.toContain(LEGACY_SERVICE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is not consulted when the dir's own item is unreadable", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _opts: unknown, cb: unknown) => {
      const done = cb as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
      // Exit 51 (authorization denied), not 44 — the item exists, we just cannot read it.
      if (args[2] === ownService(hostDefaultDir)) done(Object.assign(new Error("denied"), { code: 51 }));
      else done(null, { stdout: creds(), stderr: "" });
      return {} as never;
    });
    vi.stubGlobal("fetch", vi.fn());

    expect(await quota.fetchClaudeQuotaForConfigDir(hostDefaultDir)).toBeNull();
    expect(servicesTried()).not.toContain(LEGACY_SERVICE);
  });

  it("still covers a genuine legacy install: the host default dir with no item of its own", async () => {
    keychainByService({ [LEGACY_SERVICE]: creds() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(usageBody), { status: 200 })));

    const windows = await quota.fetchClaudeQuotaForConfigDir(hostDefaultDir);

    expect(windows?.map((w) => w.usedPercent)).toEqual([81, 54]);
    expect(servicesTried()).toContain(LEGACY_SERVICE);
  });

  it("is never offered to a pooled dir, which cannot be the legacy item's owner", async () => {
    keychainByService({ [LEGACY_SERVICE]: creds() });
    vi.stubGlobal("fetch", vi.fn());

    expect(await quota.fetchClaudeQuotaForConfigDir("/tmp/pooled-acct")).toBeNull();
    expect(servicesTried()).not.toContain(LEGACY_SERVICE);
  });
});
