import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues as issuesTable } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { getVisibleAgentIds } from "../routes/authz.js";

const JOINED_SET_TTL_MS = 30_000;
const ISSUE_AGENT_CACHE_TTL_MS = 60_000;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Per-connection live-event visibility filter for a NON-privileged board user.
 *
 * Without this, the company live-event websocket forwards every event in the
 * company to every connected client — so a restricted member (operator/viewer)
 * receives toasts and run cards for agents they never joined (a privacy leak:
 * "another teacher's message shows up after ~18s"). Privileged actors (owner /
 * admin / instance admin / local board / agent keys) are never wrapped with
 * this filter and keep seeing everything.
 *
 * Scope rule mirrors `isPrivilegedAgentViewer`: a restricted user may only see
 * events that concern an agent they have JOINED (agent_memberships.state =
 * "joined"), plus their own user actions. Anything we cannot attribute to a
 * visible agent is dropped (privacy-first).
 */
export function createBoardUserEventFilter(
  db: Db,
  companyId: string,
  userId: string,
): (event: LiveEvent) => boolean | Promise<boolean> {
  let joinedSet: Set<string> = new Set();
  let joinedLoadedAt = 0;
  let joinedInFlight: Promise<Set<string>> | null = null;
  const issueAgentCache = new Map<string, { agentId: string | null; at: number }>();

  async function loadJoinedSet(): Promise<Set<string>> {
    // Includes joined agents + their transitive reports (hierarchical
    // visibility) so a manager's live events stay consistent with their agent
    // list.
    return getVisibleAgentIds(db, companyId, userId);
  }

  async function getJoinedSet(now: number): Promise<Set<string>> {
    if (now - joinedLoadedAt < JOINED_SET_TTL_MS) return joinedSet;
    if (!joinedInFlight) {
      joinedInFlight = loadJoinedSet()
        .then((set) => {
          joinedSet = set;
          joinedLoadedAt = Date.now();
          return set;
        })
        .finally(() => {
          joinedInFlight = null;
        });
    }
    return joinedInFlight;
  }

  async function resolveIssueAgentId(issueId: string, now: number): Promise<string | null> {
    const cached = issueAgentCache.get(issueId);
    if (cached && now - cached.at < ISSUE_AGENT_CACHE_TTL_MS) return cached.agentId;
    const row = await db
      .select({ agentId: issuesTable.assigneeAgentId })
      .from(issuesTable)
      .where(eq(issuesTable.id, issueId))
      .then((rows) => rows[0] ?? null);
    const agentId = row?.agentId ?? null;
    issueAgentCache.set(issueId, { agentId, at: Date.now() });
    return agentId;
  }

  return (event: LiveEvent): boolean | Promise<boolean> => {
    const now = Date.now();
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const agentId = readString(payload.agentId);

    // Events that name an agent: visible only if the user joined that agent.
    if (agentId) {
      const set = joinedSet;
      // Fast path when the cache is warm; otherwise refresh then decide.
      if (now - joinedLoadedAt < JOINED_SET_TTL_MS) return set.has(agentId);
      return getJoinedSet(now).then((s) => s.has(agentId));
    }

    // Activity on an issue with no explicit agent: attribute via the issue's
    // assignee agent, and always allow the user's own actions.
    if (event.type === "activity.logged") {
      const actorType = readString(payload.actorType);
      const actorId = readString(payload.actorId);
      if (actorType === "user" && actorId === userId) return true;
      const entityType = readString(payload.entityType);
      const entityId = readString(payload.entityId);
      if (entityType === "issue" && entityId) {
        return Promise.all([getJoinedSet(now), resolveIssueAgentId(entityId, now)]).then(
          ([set, issueAgentId]) => (issueAgentId ? set.has(issueAgentId) : false),
        );
      }
    }

    // Anything we cannot attribute to a visible agent is dropped.
    return false;
  };
}
