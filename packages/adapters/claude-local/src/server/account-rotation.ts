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
  const selection = await selectHealthyClaudeAccountDir({
    pool,
    thresholdPercent,
    activeDir: activeClaudeAccountDir,
    probeUsedPercent: async (dir) => (claudeAccountIsCoolingDown(dir, nowMs) ? 100 : 0),
  });
  if (!selection) return null;
  activeClaudeAccountDir = selection.dir;
  return { selection, pool, thresholdPercent };
}

export function getActiveClaudeAccountDir(): string | null {
  return activeClaudeAccountDir;
}

export function resetClaudeAccountRotationStateForTests(): void {
  activeClaudeAccountDir = null;
  claudeAccountCooldownUntil.clear();
}
