import path from "node:path";
import { eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { RuntimeAccountsResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const RUNTIME_ACCOUNTS_TIMEOUT_MS = 20_000;

/**
 * Point the Claude adapter at this instance's pinned-account file.
 *
 * The pin names a host path (a credential directory), so it is stored beside the
 * instance's other host state rather than in the DB — and losing it degrades
 * safely to automatic rotation. Idempotent, and never overrides an operator's
 * own PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE.
 */
export function ensureClaudeAccountPinFileEnv(): string {
  const existing = process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE;
  if (typeof existing === "string" && existing.trim()) return existing.trim();
  const file = path.join(resolvePaperclipInstanceRoot(), "claude-account-pin.json");
  process.env.PAPERCLIP_CLAUDE_ACCOUNT_PIN_FILE = file;
  return file;
}

/**
 * Describe the credential-rotation pool each adapter is running on, for the
 * company's agents.
 *
 * The pool is agent config, so this reads the configured pool strings for the
 * company's agents of that adapter type and hands them to the adapter, which
 * joins them with its in-process rotation state and the provider's account
 * identities. Read-only.
 */
export async function fetchRuntimeAccounts(
  db: Db,
  companyId: string,
): Promise<RuntimeAccountsResult[]> {
  const adapters = listServerAdapters().filter((a) => a.describeRuntimeAccounts != null);
  if (adapters.length === 0) return [];

  const rows = await db
    .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const forAdapter = rows.filter((row) => row.adapterType === adapter.type);
      const pools: string[] = [];
      for (const row of forAdapter) {
        const config = (row.adapterConfig ?? {}) as Record<string, unknown>;
        const raw = config.claudeAccountConfigDirs;
        if (typeof raw === "string" && raw.trim()) pools.push(raw);
      }
      const result = await withTimeout(
        adapter.type,
        adapter.describeRuntimeAccounts!(pools),
      );
      // Count only agents that actually carry a pool — "48 agents share this
      // pool" is the useful number, not "48 agents exist".
      return { ...result, agentCount: pools.length };
    }),
  );

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    return [{
      provider: adapters[index]!.type,
      activeResolved: false,
      entries: [],
      agentCount: 0,
      viewerReason: null,
      pinnedDir: null,
      canSwitch: false,
      error: String(result.reason),
    }];
  });
}

/**
 * Pin runs to `dir`, or clear the pin with null.
 *
 * Validates against the pool actually configured on this company's agents, so a
 * forged or stale path cannot point runs at an arbitrary directory on the host.
 */
export async function setRuntimeAccountPin(
  db: Db,
  companyId: string,
  dir: string | null,
): Promise<
  | { kind: "ok"; persisted: boolean }
  | { kind: "unknown_dir" }
  | { kind: "unsupported" }
> {
  ensureClaudeAccountPinFileEnv();
  const adapter = listServerAdapters().find((a) => a.setRuntimeAccountPin != null);
  if (!adapter) return { kind: "unsupported" };

  if (dir != null) {
    const results = await fetchRuntimeAccounts(db, companyId);
    const known = new Set(
      results.flatMap((result) => result.entries.map((entry) => entry.dir)),
    );
    // Compare resolved paths so "~/x" and "/Users/me/x" are the same account.
    const resolved = path.resolve(dir.replace(/^~(?=$|[/\\])/, process.env.HOME ?? "~"));
    if (!known.has(resolved)) return { kind: "unknown_dir" };
    return { kind: "ok", persisted: adapter.setRuntimeAccountPin!(resolved).persisted };
  }
  return { kind: "ok", persisted: adapter.setRuntimeAccountPin!(null).persisted };
}

async function withTimeout(
  adapterType: string,
  task: Promise<RuntimeAccountsResult>,
): Promise<RuntimeAccountsResult> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<RuntimeAccountsResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            provider: adapterType,
            activeResolved: false,
            entries: [],
            agentCount: 0,
            viewerReason: null,
            pinnedDir: null,
            canSwitch: false,
            error: `account lookup timed out after ${Math.round(RUNTIME_ACCOUNTS_TIMEOUT_MS / 1000)}s`,
          });
        }, RUNTIME_ACCOUNTS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
