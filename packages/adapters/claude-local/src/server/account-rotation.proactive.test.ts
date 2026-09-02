import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

/**
 * Rotation driven by what the provider says, not only by what a failed run said.
 *
 * The pool used to learn an account was full ONLY from a run that came back with
 * a quota error, so every exhausted account cost a wasted heartbeat before the
 * switch. Selection now also reads each dir's usage up front. The read is
 * best-effort — an idle account's access token is usually expired — so these
 * pin both halves: act on a usage read when there is one, and behave exactly as
 * before when there is not.
 */

const fetchQuotaMock = vi.hoisted(() => vi.fn());
vi.mock("./quota.js", () => ({ fetchClaudeQuotaForConfigDir: fetchQuotaMock }));

const {
  chooseClaudeAccountDirForRun,
  markClaudeAccountCoolingDown,
  markClaudeAccountNeedsLogin,
  resetClaudeAccountRotationStateForTests,
} = await import("./account-rotation.js");

const A = path.resolve("/acct/a");
const B = path.resolve("/acct/b");
const C = path.resolve("/acct/c");
const config = { claudeAccountConfigDirs: "/acct/a, /acct/b, /acct/c" };

/** Usage per dir: a number is that account's worst window, null is "unreadable". */
function usage(byDir: Record<string, number | null>): void {
  fetchQuotaMock.mockImplementation(async (dir: string) => {
    const used = byDir[dir];
    return used == null ? null : [{ label: "Current week (all models)", usedPercent: used }];
  });
}

beforeEach(() => {
  resetClaudeAccountRotationStateForTests();
  fetchQuotaMock.mockReset();
  delete process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE;
});

describe("usage-aware account selection", () => {
  it("skips an account already at its limit instead of spending a run to find out", async () => {
    usage({ [A]: 97, [B]: 4, [C]: 2 });

    const chosen = await chooseClaudeAccountDirForRun({ config });

    // No cooldown mark exists — the only signal is the live usage read.
    expect(chosen?.selection.dir).toBe(B);
    expect(chosen?.selection.usedPercent).toBe(4);
  });

  it("takes the worst window, so a maxed weekly limit is not hidden by a fresh session", async () => {
    fetchQuotaMock.mockImplementation(async (dir: string) =>
      dir === A
        ? [
            { label: "Current session", usedPercent: 3 },
            { label: "Current week (all models)", usedPercent: 99 },
          ]
        : [{ label: "Current week (all models)", usedPercent: 10 }],
    );

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(B);
  });

  it("ignores windows with no percentage, like a disabled extra-usage pool", async () => {
    fetchQuotaMock.mockImplementation(async () => [
      { label: "Current session", usedPercent: 12 },
      { label: "Extra usage", usedPercent: null },
    ]);

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);
  });

  it("respects a configured threshold below the default", async () => {
    usage({ [A]: 60, [B]: 5, [C]: 5 });

    const chosen = await chooseClaudeAccountDirForRun({
      config: { ...config, quotaSwitchThresholdPercent: 50 },
    });

    expect(chosen?.selection.dir).toBe(B);
  });

  it("reports every account exhausted rather than pretending one is healthy", async () => {
    usage({ [A]: 100, [B]: 99, [C]: 96 });

    const chosen = await chooseClaudeAccountDirForRun({ config });

    expect(chosen?.selection.exhausted).toBe(true);
  });
});

describe("unreadable usage", () => {
  it("keeps the current account when its usage cannot be read", async () => {
    // The common real case: an idle account's access token has expired, so its
    // usage reads as unknown. That is not evidence it is full, and rotating on
    // it would drop a warm session for nothing.
    usage({ [A]: null, [B]: 4, [C]: 4 });

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);
  });

  it("still rotates off an unreadable account once a real run reports its quota", async () => {
    usage({ [A]: null, [B]: null, [C]: null });
    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);

    markClaudeAccountCoolingDown(A, Date.now() + 60 * 60 * 1000);

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(B);
  });

  it("does not fail the selection when the usage read throws", async () => {
    fetchQuotaMock.mockRejectedValue(new Error("keychain unavailable"));

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(A);
  });
});

describe("accounts that cannot authenticate at all", () => {
  it("walks past an account that needs a new login", async () => {
    // An auth failure earns no quota cooldown, so without this mark the sticky
    // pointer parks on the dead account and every later heartbeat fails there.
    usage({ [A]: null, [B]: null, [C]: null });
    markClaudeAccountNeedsLogin(A);

    expect((await chooseClaudeAccountDirForRun({ config }))?.selection.dir).toBe(B);
  });

  it("gives the account another chance once the login window has passed", async () => {
    // Two dirs so the walk has nowhere else to go, isolating "is A eligible?".
    const pair = { claudeAccountConfigDirs: "/acct/a, /acct/b" };
    usage({ [A]: null, [B]: null });
    const now = Date.now();
    markClaudeAccountNeedsLogin(A, now);

    expect((await chooseClaudeAccountDirForRun({ config: pair, now }))?.selection.dir).toBe(B);

    // 15 minutes on, the operator may have re-authenticated it, so A is back in
    // the running — shown here by B being unavailable and A picked rather than
    // the pool reporting itself exhausted.
    const later = now + 16 * 60 * 1000;
    markClaudeAccountCoolingDown(B, later + 60 * 60 * 1000);
    const chosen = await chooseClaudeAccountDirForRun({ config: pair, now: later });
    expect(chosen?.selection.dir).toBe(A);
    expect(chosen?.selection.exhausted).toBe(false);
  });
});
