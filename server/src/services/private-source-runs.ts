/**
 * Tracks which agent runs have read PRIVATE user data (Gmail, Google Chat history)
 * during this process's lifetime.
 *
 * Why in-memory rather than a column on heartbeat_runs: the only consumers are
 * in-flight — a run marks itself when it calls a mail/chat endpoint, and the comment
 * writer and run-excerpt writer check it moments later, in the same process. A
 * migration would buy durability we don't need, and the failure mode of losing the
 * flag across a restart is "a comment isn't tagged", not a leak of new data.
 *
 * This deliberately does NOT block anything. It marks provenance so that
 *   - comments written by such a run carry `metadata.privateSource`, and
 *   - the run's stdout excerpt (which can contain quoted mail) is not persisted
 * while leaving the agent's own output path untouched.
 */

/** Runs stay marked long enough to outlive any single heartbeat. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** Bound the map so a long-lived process can't accumulate forever. */
const MAX_ENTRIES = 5_000;

const markedRuns = new Map<string, number>();

function prune(nowMs: number): void {
  for (const [runId, expiresAt] of markedRuns) {
    if (expiresAt <= nowMs) markedRuns.delete(runId);
  }
  if (markedRuns.size <= MAX_ENTRIES) return;
  // Oldest-first eviction; Map preserves insertion order.
  const excess = markedRuns.size - MAX_ENTRIES;
  let removed = 0;
  for (const runId of markedRuns.keys()) {
    markedRuns.delete(runId);
    if (++removed >= excess) break;
  }
}

/** Record that this run read private mail/chat. No-op without a run id. */
export function markRunReadPrivateSource(runId: string | null | undefined): void {
  if (!runId) return;
  const now = Date.now();
  prune(now);
  markedRuns.set(runId, now + TTL_MS);
}

/** Whether this run has read private mail/chat. */
export function runReadPrivateSource(runId: string | null | undefined): boolean {
  if (!runId) return false;
  const expiresAt = markedRuns.get(runId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    markedRuns.delete(runId);
    return false;
  }
  return true;
}

/** Test seam. */
export function resetPrivateSourceRunsForTest(): void {
  markedRuns.clear();
}
