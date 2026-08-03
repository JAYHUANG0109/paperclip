import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asBoolean, asNumber } from "@paperclipai/adapter-utils/server-utils";

/**
 * Quota-aware Claude account rotation, shared by BOTH execution lanes.
 *
 * This lives in its own module because the CLI lane (`execute.ts`) and the ACP
 * lane (`acp.ts`) both need it and `execute.ts` imports `acp.ts` — keeping the
 * sticky pointer and the cooldown map here avoids an import cycle and, more
 * importantly, guarantees the two lanes share ONE pool state. When rotation
 * lived in `execute.ts` the ACP lane returned before ever reaching it, so
 * `claudeAccountConfigDirs` was silently dead config for every ACP agent.
 */

// Sticky pointer into the account-rotation pool: which credential dir the last
// run settled on. We start each rotation probe here so we stay on one account
// until it crosses the quota threshold, then advance — instead of re-probing
// the whole pool every heartbeat.
let activeClaudeAccountDir: string | null = null;

// Reactive quota tracking. On macOS hosts Claude credentials live in the
// Keychain (no per-dir token file) and there is no non-interactive `claude
// usage` command, so the proactive CLI `/usage` scrape is unreliable (it hangs /
// times out) — it cannot tell whether an account is over quota. Instead we learn
// each account's state from the GROUND TRUTH: when a real run returns a
// provider-quota / rate-limit error we mark that credential dir as cooling down
// until its quota window resets, and rotation skips cooling accounts. Map value
// is the epoch-ms the dir becomes usable again.
const claudeAccountCooldownUntil = new Map<string, number>();

/** Fallback cooldown when the provider gave us no reset time. */
export const CLAUDE_ACCOUNT_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

export function claudeAccountIsCoolingDown(dir: string, now: number): boolean {
  const until = claudeAccountCooldownUntil.get(dir);
  if (until == null) return false;
  if (until <= now) {
    claudeAccountCooldownUntil.delete(dir);
    return false;
  }
  return true;
}

/** Mark a credential dir as quota-limited until `until` (epoch ms). */
export function markClaudeAccountCoolingDown(dir: string, until: number): void {
  const existing = claudeAccountCooldownUntil.get(dir);
  // Keep the latest (furthest-out) reset we know about.
  if (existing == null || until > existing) claudeAccountCooldownUntil.set(dir, until);
}

/**
 * Parse the configured account-rotation pool (`config.claudeAccountConfigDirs`)
 * into an ordered, de-duplicated list of absolute credential directories. Each
 * dir is a separately pre-authenticated Claude account (its own subscription
 * pool). Accepts newline / comma / semicolon separated paths, and expands a
 * leading `~`.
 */
export function parseClaudeAccountConfigDirs(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const partRaw of raw.split(/[\n,;]+/)) {
    const part = partRaw.trim();
    if (!part) continue;
    const expanded = part === "~" || part.startsWith("~/") || part.startsWith("~\\")
      ? path.join(os.homedir(), part.slice(1).replace(/^[/\\]+/, ""))
      : part;
    const resolved = path.resolve(expanded);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export interface ClaudeAccountSelection {
  dir: string;
  usedPercent: number | null;
  rotated: boolean;
  exhausted: boolean;
}

/**
 * Pick which pre-authenticated Claude account to run on, quota-aware and
 * hands-off. Starts at `activeDir` (sticky) and walks the pool, wrapping, so a
 * reset account earlier in the pool becomes reusable. Returns the first account
 * under `thresholdPercent`; if none are known-healthy it prefers an account
 * whose quota couldn't be read over a known-full one; if every account is
 * known to be at/over the threshold it sticks with the start account and marks
 * `exhausted` so the caller can warn. Pure except for the injected probe — unit
 * tested in execute.account-rotation.test.ts.
 */
export async function selectHealthyClaudeAccountDir(input: {
  pool: string[];
  thresholdPercent: number;
  activeDir: string | null;
  probeUsedPercent: (dir: string) => Promise<number | null>;
}): Promise<ClaudeAccountSelection | null> {
  const { pool, thresholdPercent, activeDir, probeUsedPercent } = input;
  if (pool.length === 0) return null;
  const activeIdx = activeDir ? pool.indexOf(activeDir) : -1;
  const startIdx = activeIdx >= 0 ? activeIdx : 0;
  let firstUnknown: string | null = null;
  for (let i = 0; i < pool.length; i++) {
    const dir = pool[(startIdx + i) % pool.length]!;
    let used: number | null = null;
    try {
      used = await probeUsedPercent(dir);
    } catch {
      used = null;
    }
    if (used == null) {
      if (firstUnknown == null) firstUnknown = dir;
      continue;
    }
    if (used < thresholdPercent) {
      return { dir, usedPercent: used, rotated: dir !== activeDir, exhausted: false };
    }
  }
  if (firstUnknown != null) {
    return { dir: firstUnknown, usedPercent: null, rotated: firstUnknown !== activeDir, exhausted: false };
  }
  const stick = pool[startIdx]!;
  return { dir: stick, usedPercent: null, rotated: false, exhausted: true };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

export function resolveClaudeBillingType(
  env: Record<string, string>,
): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

export function resolveClaudeQuotaSwitchThreshold(config: Record<string, unknown>): number {
  const raw = asNumber(config.quotaSwitchThresholdPercent, 95);
  if (!Number.isFinite(raw) || raw <= 0) return 95;
  return Math.min(100, Math.max(1, raw));
}

/**
 * The gate both lanes apply before rotating: opt-in flag on, local run, and a
 * subscription (rotation is meaningless for API-key or Bedrock billing, which
 * have no per-account subscription quota).
 */
export function claudeAccountRotationApplies(input: {
  config: Record<string, unknown>;
  executionTargetIsRemote: boolean;
  billingType: "api" | "subscription" | "metered_api";
}): boolean {
  return (
    asBoolean(input.config.autoSwitchAccountOnQuota, true) &&
    !input.executionTargetIsRemote &&
    input.billingType === "subscription" &&
    parseClaudeAccountConfigDirs(input.config.claudeAccountConfigDirs).length > 0
  );
}

/**
 * Choose this run's credential dir from the pool and advance the sticky
 * pointer. Callers must have checked `claudeAccountRotationApplies` first.
 *
 * Reactive, not proactive: a dir counts as "over threshold" only while it is
 * cooling down from a real provider-quota error (see
 * `markClaudeAccountCoolingDown`). This avoids the unreliable interactive
 * `/usage` scrape entirely.
 */
export async function chooseClaudeAccountDirForRun(input: {
  config: Record<string, unknown>;
  now?: number;
}): Promise<{ selection: ClaudeAccountSelection; pool: string[]; thresholdPercent: number } | null> {
  const pool = parseClaudeAccountConfigDirs(input.config.claudeAccountConfigDirs);
  if (pool.length === 0) return null;
  const thresholdPercent = resolveClaudeQuotaSwitchThreshold(input.config);
  const nowMs = input.now ?? Date.now();
  // An operator pin becomes the START of the walk rather than a hard override.
  // That gives exactly the behavior asked for: the pinned account is preferred,
  // a quota-limited pin is temporarily walked past so agents keep working, and
  // because the walk restarts at the pin every run it is picked back up the
  // moment its window resets. A pin naming a dir outside the pool is ignored.
  const pinned = getPinnedClaudeAccountDir();
  const startDir = pinned && pool.includes(pinned) ? pinned : activeClaudeAccountDir;
  const selection = await selectHealthyClaudeAccountDir({
    pool,
    thresholdPercent,
    activeDir: startDir,
    probeUsedPercent: async (dir) => (claudeAccountIsCoolingDown(dir, nowMs) ? 100 : 0),
  });
  if (!selection) return null;
  activeClaudeAccountDir = selection.dir;
  return { selection, pool, thresholdPercent };
}

export function getActiveClaudeAccountDir(): string | null {
  return activeClaudeAccountDir;
}

/**
 * Operator-chosen account, or null for fully automatic rotation.
 *
 * Persisted to a file (not the DB) because it names a HOST path — the credential
 * directories live on the machine running Paperclip, the same scope as the file
 * itself — and because losing it degrades safely to automatic rotation. The path
 * comes from PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE, which the server sets at boot;
 * with no env var there is no pin and rotation is automatic.
 */
let pinnedClaudeAccountDir: string | null = null;
let pinHydrated = false;

function pinFilePath(): string | null {
  const raw = process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/** Load the pin from disk once per process, so it survives a restart. */
export function hydratePinnedClaudeAccountDir(): string | null {
  if (pinHydrated) return pinnedClaudeAccountDir;
  pinHydrated = true;
  const file = pinFilePath();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const dir = parsed.dir;
    pinnedClaudeAccountDir = typeof dir === "string" && dir.trim() ? path.resolve(dir.trim()) : null;
  } catch {
    // Missing or unreadable pin file simply means "no pin".
    pinnedClaudeAccountDir = null;
  }
  return pinnedClaudeAccountDir;
}

export function getPinnedClaudeAccountDir(): string | null {
  return hydratePinnedClaudeAccountDir();
}

/**
 * Pin runs to `dir`, or pass null to return to automatic rotation. Writing the
 * file is best-effort: an unwritable path still changes the live pin for this
 * process rather than failing the operator's action outright.
 */
export function setPinnedClaudeAccountDir(dir: string | null): { persisted: boolean } {
  hydratePinnedClaudeAccountDir();
  pinnedClaudeAccountDir = dir ? path.resolve(dir) : null;
  // Move the sticky pointer too, so the change is visible before the next run.
  if (pinnedClaudeAccountDir) activeClaudeAccountDir = pinnedClaudeAccountDir;
  const file = pinFilePath();
  if (!file) return { persisted: false };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ dir: pinnedClaudeAccountDir }, null, 2), { mode: 0o600 });
    return { persisted: true };
  } catch {
    return { persisted: false };
  }
}

/** When `dir` becomes usable again, or null if it is not cooling down. */
export function claudeAccountCooldownUntilMs(dir: string, now: number): number | null {
  if (!claudeAccountIsCoolingDown(dir, now)) return null;
  return claudeAccountCooldownUntil.get(dir) ?? null;
}

export interface ClaudeAccountPoolEntry {
  dir: string;
  /** True for the account the next local subscription run would use. */
  active: boolean;
  /** ISO timestamp this account becomes usable again, or null when healthy. */
  coolingDownUntil: string | null;
  /** True when an operator pinned runs to this account. */
  pinned: boolean;
}

/**
 * Snapshot of the rotation pool for operator-facing surfaces.
 *
 * `activeDir` is null until the first local subscription run of this server
 * process has picked an account — the sticky pointer is in-process state, not
 * persisted, so it resets on restart and the pool starts again at its head.
 * Callers should present a null active dir as "the next run will use the first
 * entry", not as "no account configured".
 */
export function describeClaudeAccountPool(
  pool: string[],
  now = Date.now(),
): { activeDir: string | null; pinnedDir: string | null; entries: ClaudeAccountPoolEntry[] } {
  const activeDir = activeClaudeAccountDir;
  const pinnedDir = getPinnedClaudeAccountDir();
  // Mirror the run-time choice: a healthy pin is what the next run uses, and a
  // cooling pin is walked past — so the card never claims a quota-limited
  // account is the one in use.
  const usable = (dir: string | null): string | null =>
    dir != null && pool.includes(dir) && !claudeAccountIsCoolingDown(dir, now) ? dir : null;
  const effectiveActive =
    usable(pinnedDir)
    // Only trust the sticky pointer if it is still healthy — after a quota hit it
    // still names the account that just failed, and reporting that as "in use"
    // would contradict what the next run will actually do.
    ?? usable(activeDir)
    ?? pool.find((dir) => !claudeAccountIsCoolingDown(dir, now))
    ?? pool[0]
    ?? null;
  return {
    activeDir,
    pinnedDir,
    entries: pool.map((dir) => {
      const until = claudeAccountCooldownUntilMs(dir, now);
      return {
        dir,
        active: dir === effectiveActive,
        coolingDownUntil: until != null ? new Date(until).toISOString() : null,
        pinned: dir === pinnedDir,
      };
    }),
  };
}

export function resetClaudeAccountRotationStateForTests(): void {
  activeClaudeAccountDir = null;
  claudeAccountCooldownUntil.clear();
  claudeAccountIdentityCache.clear();
  pinnedClaudeAccountDir = null;
  pinHydrated = false;
}

// `claude auth status` is a subprocess per directory (~1s each), and the answer
// only changes when someone re-authenticates. Cache it so an operator refreshing
// the Costs page does not spawn a probe per pool entry per request.
const CLAUDE_ACCOUNT_IDENTITY_TTL_MS = 5 * 60 * 1000;
const claudeAccountIdentityCache = new Map<
  string,
  { at: number; value: ClaudeAccountIdentity }
>();

export interface ClaudeAccountIdentity {
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
  loggedIn: boolean;
}

const UNKNOWN_IDENTITY: ClaudeAccountIdentity = {
  email: null,
  subscriptionType: null,
  orgName: null,
  loggedIn: false,
};

/**
 * Resolve which account a credential directory holds, memoized.
 *
 * `readIdentity` is injected so this stays unit-testable without spawning the
 * Claude CLI; production passes the `claude auth status --json` reader.
 */
export async function resolveClaudeAccountIdentity(
  dir: string,
  readIdentity: (dir: string) => Promise<ClaudeAccountIdentity | null>,
  now = Date.now(),
): Promise<ClaudeAccountIdentity> {
  const cached = claudeAccountIdentityCache.get(dir);
  if (cached && now - cached.at < CLAUDE_ACCOUNT_IDENTITY_TTL_MS) return cached.value;
  let value: ClaudeAccountIdentity;
  try {
    value = (await readIdentity(dir)) ?? UNKNOWN_IDENTITY;
  } catch {
    value = UNKNOWN_IDENTITY;
  }
  // Only a successful read is worth caching — a transient failure should not
  // pin "logged out" for the whole TTL.
  if (value.loggedIn) claudeAccountIdentityCache.set(dir, { at: now, value });
  return value;
}

/**
 * Merge the pools configured across agents into one ordered, de-duplicated
 * pool. Agents normally share one pool string; when they disagree, every
 * configured directory still shows up exactly once, in first-seen order.
 */
export function mergeClaudeAccountPools(configuredPools: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of configuredPools) {
    for (const dir of parseClaudeAccountConfigDirs(raw)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out;
}
