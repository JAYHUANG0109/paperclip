import { eq } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { RuntimeAccountsResult } from "@paperclipai/shared";
import { listServerAdapters } from "../adapters/registry.js";

const RUNTIME_ACCOUNTS_TIMEOUT_MS = 20_000;

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
      error: String(result.reason),
    }];
  });
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
            error: `account lookup timed out after ${Math.round(RUNTIME_ACCOUNTS_TIMEOUT_MS / 1000)}s`,
          });
        }, RUNTIME_ACCOUNTS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
