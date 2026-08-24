import cluster from "node:cluster";

/**
 * Which duties this process owns.
 *
 * Paperclip runs as a single Node process today, so one core serves every
 * request while the other thirteen idle. Clustering fixes that, but the server
 * does two things at startup that assume it is the ONLY copy:
 *
 *   1. Eight `setInterval` schedulers — heartbeat dispatch, digest pings, wiki
 *      distill, monthly rollups, summaries, feedback export. Running these in
 *      every worker would dispatch each agent N times and send staff the same
 *      Google Chat message N times. Rollback does not un-send a message, which
 *      is why this gate lands BEFORE clustering is switched on.
 *   2. Embedded PostgreSQL — N workers racing to initialise one data directory.
 *
 * `cluster.isPrimary` is `true` in an unclustered process, so every predicate
 * here returns exactly what it returns today: this module is deliberately inert
 * until someone actually forks workers.
 *
 * PAPERCLIP_PROCESS_ROLE overrides for tests and for running a dedicated
 * scheduler process separately from the web tier:
 *   "leader" — own the schedulers (and embedded PG)
 *   "worker" — serve HTTP only
 */
export type ProcessRole = "leader" | "worker";

function envRole(): ProcessRole | null {
  const raw = process.env.PAPERCLIP_PROCESS_ROLE?.trim().toLowerCase();
  if (raw === "leader" || raw === "worker") return raw;
  return null;
}

export function processRole(): ProcessRole {
  return envRole() ?? (cluster.isPrimary ? "leader" : "worker");
}

/**
 * Whether this process runs the recurring background schedulers.
 * Exactly one process in a deployment may answer true.
 */
export function isSchedulerLeader(): boolean {
  return processRole() === "leader";
}

/**
 * Whether this process owns singleton startup resources — embedded PostgreSQL,
 * one-shot migrations, anything that writes to a shared directory.
 */
export function ownsSingletonResources(): boolean {
  return processRole() === "leader";
}

/** For logging: a short label so duplicated work is attributable to a process. */
export function processRoleLabel(): string {
  const role = processRole();
  return cluster.isPrimary ? role : `${role}#${cluster.worker?.id ?? "?"}`;
}
