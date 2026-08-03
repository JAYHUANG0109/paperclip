import type { RuntimeAccountsResult } from "@paperclipai/adapter-utils";
import {
  describeClaudeAccountPool,
  mergeClaudeAccountPools,
  resolveClaudeAccountIdentity,
  type ClaudeAccountIdentity,
} from "./account-rotation.js";
import { readClaudeAuthStatus } from "./quota.js";

/**
 * Read-only answer to "which Claude account is Paperclip running on right now?".
 *
 * The rotation pool lives in agent config, the sticky pointer and cooldowns live
 * in this process's memory, and the account identity behind each directory only
 * the Claude CLI can tell us — so this joins all three. It never mutates
 * rotation state and never switches accounts.
 */
export async function describeClaudeRuntimeAccounts(
  configuredPools: string[],
  agentCount = 0,
): Promise<RuntimeAccountsResult> {
  const pool = mergeClaudeAccountPools(configuredPools);
  const { activeDir, pinnedDir, entries } = describeClaudeAccountPool(pool);

  const readIdentity = async (dir: string): Promise<ClaudeAccountIdentity | null> => {
    const status = await readClaudeAuthStatus(dir);
    if (!status) return null;
    return {
      email: status.email,
      subscriptionType: status.subscriptionType,
      orgName: status.orgName,
      loggedIn: status.loggedIn,
    };
  };

  const resolved = await Promise.all(
    entries.map(async (entry) => {
      const identity = await resolveClaudeAccountIdentity(entry.dir, readIdentity);
      return { ...entry, ...identity };
    }),
  );

  return {
    provider: "anthropic",
    activeResolved: activeDir != null,
    entries: resolved,
    agentCount,
    pinnedDir,
    // The route fills these in — the adapter has no view of the caller.
    viewerReason: null,
    canSwitch: false,
  };
}
