import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentMemberships, agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { forbidden, unauthorized } from "../errors.js";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

export function assertBoardOrAgent(req: Request) {
  if (req.actor.type === "agent") {
    return;
  }
  if (req.actor.type === "board") {
    assertBoardOrgAccess(req);
    return;
  }
  throw forbidden("Board or agent access required");
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

/**
 * Restricted member view. When `restrictVisibility` is on, a non-privileged
 * board user (company role operator/viewer) is scoped to only their own work.
 * Privileged = the local implicit board, an instance admin, or a company
 * owner/admin; agent-key actors are never restricted here (bounded elsewhere).
 * Returns true (privileged → see everything) when the flag is off, preserving
 * default behaviour.
 */
export function isPrivilegedMemberViewer(
  req: Request,
  companyId: string,
  restrictVisibility: boolean,
): boolean {
  if (!restrictVisibility) return true;
  if (req.actor.type !== "board") return true;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const role = Array.isArray(req.actor.memberships)
    ? req.actor.memberships.find((m) => m.companyId === companyId)?.membershipRole
    : undefined;
  return role === "owner" || role === "admin";
}

/** The set of agent ids a user has joined (agent_memberships.state = "joined"). */
export async function getJoinedAgentIds(
  db: Db,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: agentMemberships.agentId })
    .from(agentMemberships)
    .where(
      and(
        eq(agentMemberships.companyId, companyId),
        eq(agentMemberships.userId, userId),
        eq(agentMemberships.state, "joined"),
      ),
    );
  return rows.map((row) => row.agentId);
}

/**
 * The set of agent ids a user may SEE under restricted-visibility mode:
 * every agent they have joined, PLUS all agents that report (transitively) to
 * a joined agent. This is the hierarchical "a manager sees their reports'
 * agents" rule (Feature B) — a user assigned to a manager agent sees the whole
 * subtree below it via the `agents.reportsTo` chain.
 *
 * The company agent set is small (tens of rows), so we load (id, reportsTo)
 * once and walk the tree in memory with a visited guard (cycle-safe). Returns
 * just the joined set when the user has joined nothing.
 */
export async function getVisibleAgentIds(
  db: Db,
  companyId: string,
  userId: string,
): Promise<Set<string>> {
  const joined = await getJoinedAgentIds(db, companyId, userId);
  const visible = new Set(joined);
  if (visible.size === 0) return visible;

  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const childrenByManager = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.reportsTo) continue;
    const list = childrenByManager.get(row.reportsTo) ?? [];
    list.push(row.id);
    childrenByManager.set(row.reportsTo, list);
  }

  const queue = [...visible];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of childrenByManager.get(current) ?? []) {
      if (!visible.has(child)) {
        visible.add(child);
        queue.push(child);
      }
    }
  }
  return visible;
}

/**
 * Guard for org-wide oversight endpoints (dashboard, routines, goals, members,
 * activity, …). When restriction is on, non-privileged members are blocked.
 */
export function assertPrivilegedMemberView(
  req: Request,
  companyId: string,
  restrictVisibility: boolean,
): void {
  if (!isPrivilegedMemberViewer(req, companyId, restrictVisibility)) {
    throw forbidden("This view is restricted to company admins");
  }
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    agentId: null;
    runId: string | null;
    actorSource: "local_implicit" | "session" | "board_key" | "cloud_tenant";
  }
) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    const actorSource = req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key";
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
      actorSource,
    };
  }

  const actorSource =
    req.actor.source === "local_implicit" ||
      req.actor.source === "board_key" ||
      req.actor.source === "cloud_tenant"
      ? req.actor.source
      : "session";

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
    actorSource,
  };
}
