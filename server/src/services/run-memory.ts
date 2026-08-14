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
import { issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { materializeUserMemory, requesterForAgent } from "./personal-memory.js";
import { materializeRoomMemory, resolveRoomScope, roomMemoryEnabled } from "./room-memory.js";

/** The memory index every materialized directory carries. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

export interface RunMemoryContext {
  /** Absolute path to the materialized directory. */
  dir: string;
  /**
   * The owner of everything in `dir`. Exactly one is set:
   *  - `userId`      — personal memory (the agent's mapped user), or
   *  - `roomScopeId` — room memory (a group chat room), flag-gated.
   */
  userId?: string;
  roomScopeId?: string;
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
  const base = {
    PAPERCLIP_MEMORY_DIR: memory.dir,
    PAPERCLIP_MEMORY_INDEX: memory.indexPath,
  };
  // Room memory addresses a different API path and must NOT expose a user id — a
  // room run has no personal-memory write target (that comes via the room API).
  if (memory.roomScopeId) {
    return { ...base, PAPERCLIP_MEMORY_ROOM_ID: memory.roomScopeId };
  }
  if (memory.userId) {
    return { ...base, PAPERCLIP_MEMORY_USER_ID: memory.userId };
  }
  return base;
}

/** The run's issue originId — the room signal Phase 1b stamps on group-chat issues. */
async function lookupIssueOriginId(db: Db, companyId: string, issueId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .limit(1);
    return rows[0]?.originId ?? null;
  } catch {
    return null;
  }
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
  input: { companyId: string; agentId: string; issueId?: string | null },
): Promise<RunMemoryContext | null> {
  // Room memory (flag-gated): when this run's issue is a GROUP chat room (its
  // originId is surface-prefixed, set by Phase 1b for non-DM spaces), the run
  // reads the ROOM's shared memory instead of the agent's mapped user's. This
  // never touches personal memory — a separate store with its own dir. DMs and
  // non-chat runs fall through to the unchanged personal path below.
  if (roomMemoryEnabled() && input.issueId) {
    const originId = await lookupIssueOriginId(db, input.companyId, input.issueId);
    const room = resolveRoomScope(originId);
    if (room) {
      const result = await materializeRoomMemory(db, { companyId: input.companyId, roomScopeId: room.roomScopeId });
      return {
        dir: result.dir,
        roomScopeId: room.roomScopeId,
        indexPath: result.indexPath,
        entryCount: result.written.length,
      };
    }
  }

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
