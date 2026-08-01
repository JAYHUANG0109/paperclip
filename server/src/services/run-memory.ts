/**
 * Expose a run's personal memory to the agent process.
 *
 * This is the last mile of personal memory: the DB is the truth, the
 * materializer projects it onto disk, and this module decides *whose* memory a
 * given run gets and hands the adapter the environment describing it.
 *
 * ─── Whose memory ───
 *
 * The agent's mapped user, resolved from `agent_memberships` via
 * `requesterForAgent`. Whoever triggered the run is not an input and cannot be
 * one — `requesterForAgent` takes no acting user. A campus head waking a campus
 * member's agent gets the MEMBER's memory in that run, which is the whole
 * point of the rule.
 *
 * An agent with no mapping, or one mapped to several users, has no unambiguous
 * owner and therefore gets no memory directory at all. Failing closed here
 * costs nothing today (every live agent maps to exactly one user) and prevents
 * one person's memory reaching another person's agent if that changes.
 *
 * ─── Why per-run and not once ───
 *
 * Sign-in materializes too, but a run is the moment that matters: memory added
 * through the API at noon should reach the next heartbeat, not the next login.
 * The cost is one indexed query plus a few small file writes.
 */

import path from "node:path";
import type { Db } from "@paperclipai/db";
import { materializeUserMemory, requesterForAgent } from "./personal-memory.js";

/** The memory index every materialized directory carries. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

export interface RunMemoryContext {
  /** Absolute path to the materialized directory for this run's user. */
  dir: string;
  /** The agent's mapped user — the owner of everything in `dir`. */
  userId: string;
  /** Absolute path to the index file. */
  indexPath: string;
  /** How many memory files were written, excluding the index. */
  entryCount: number;
}

/**
 * Environment describing the run's memory directory.
 *
 * `PAPERCLIP_MEMORY_USER_ID` is included so an agent can address the memory API
 * (`/companies/:companyId/users/:userId/memories`) to remember something new.
 * That is not a disclosure: the agent already has read and write access to
 * exactly this user's memory, so the id tells it nothing it could not learn by
 * asking the API.
 */
export function buildRunMemoryEnv(memory: RunMemoryContext): Record<string, string> {
  return {
    PAPERCLIP_MEMORY_DIR: memory.dir,
    PAPERCLIP_MEMORY_INDEX: memory.indexPath,
    PAPERCLIP_MEMORY_USER_ID: memory.userId,
  };
}

/**
 * Resolve and materialize the memory for one run.
 *
 * Returns `null` when this run gets no memory — no mapped user, an ambiguous
 * mapping, or nothing stored. Callers treat `null` as "run without memory
 * env", never as an error.
 */
export async function prepareRunMemory(
  db: Db,
  input: { companyId: string; agentId: string },
): Promise<RunMemoryContext | null> {
  const requester = await requesterForAgent(db, input);
  // Defensive: requesterForAgent only ever builds the agent variant, but the
  // narrowing keeps this correct if MemoryRequester grows another shape.
  if (requester.kind !== "agent" || !requester.mappedUserId) return null;

  const userId = requester.mappedUserId;
  const result = await materializeUserMemory(db, { companyId: input.companyId, userId });
  return {
    dir: result.dir,
    userId,
    indexPath: path.join(result.dir, MEMORY_INDEX_FILENAME),
    entryCount: result.written.length,
  };
}
