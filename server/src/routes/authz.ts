import type { Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agentMemberships, agents, authUsers } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { forbidden, HttpError, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { responsibleUserAuthzShadowMode } from "../services/authorization.js";

/**
 * The only logins that may see/file into the reserved numbered (00–10) folders
 * — the founder's private org taxonomy. Everyone else has them stripped/hidden
 * server-side. Single source of truth, shared by the skills + folders routes.
 */
export const RESTRICTED_FOLDER_EMAILS = new Set(["tang@seasonart.org", "jay20020109@seasonart.org"]);

/** True when the actor is one of the founder logins allowed the numbered folders. */
export async function actorAllowsRestrictedFolders(req: Request, db: Db): Promise<boolean> {
  if (req.actor.type !== "board" || !req.actor.userId) return false;
  const row = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, req.actor.userId))
    .then((rows) => rows[0] ?? null);
  return RESTRICTED_FOLDER_EMAILS.has((row?.email ?? "").trim().toLowerCase());
}

function throwOrShadowResponsibleUserCompanyAccessDeny(
  req: Request,
  companyId: string,
  code: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE",
  message: string,
) {
  logger.warn({
    authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
    code,
    action: "company_access",
    companyId,
    actorAgentId: req.actor.agentId ?? null,
    responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    method: req.method,
  }, "responsible-user company access intersection denied");
  if (responsibleUserAuthzShadowMode()) return;
  throw new HttpError(403, message, { code });
}

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
  if (req.actor.type === "agent" && req.actor.onBehalfOfUserId?.trim()) {
    const membership = req.actor.onBehalfOfMemberships?.find(
      (item) => item.companyId === companyId && item.status === "active",
    );
    if (!membership) {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAVAILABLE",
        "Responsible user is unavailable for this company",
      );
      return;
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && membership.membershipRole === "viewer") {
      throwOrShadowResponsibleUserCompanyAccessDeny(
        req,
        companyId,
        "RESPONSIBLE_USER_UNAUTHORIZED",
        "Responsible user is not authorized for write access",
      );
    }
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
 * Agents a user OWNS: those whose (non-revoked) agent API key names them as the
 * responsible user. This is the human the agent runs on behalf of, so they must
 * always be able to see and assign to it.
 */
export async function getOwnedAgentIds(
  db: Db,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ agentId: agentApiKeys.agentId })
    .from(agentApiKeys)
    .where(
      and(
        eq(agentApiKeys.companyId, companyId),
        eq(agentApiKeys.responsibleUserId, userId),
        isNull(agentApiKeys.revokedAt),
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
  const owned = await getOwnedAgentIds(db, companyId, userId);
  // Seed = agents you joined PLUS agents you own (you are their responsible
  // user). A user must always be able to see and assign to their OWN agent,
  // even under restricted visibility and even if no join row exists — otherwise
  // a non-privileged member can't hand their own assistant any work.
  const visible = new Set([...joined, ...owned]);
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

/**
 * Non-throwing access check for routes that look up a resource by id
 * before responding. Prefer this over `assertCompanyAccess` whenever the
 * route can reach the access check only after a successful `getById`
 * (i.e. after confirming the resource exists).
 *
 * Using `assertCompanyAccess` in that position leaks resource existence
 * across tenants: a 404 means "no such resource" while a 403 means "exists
 * in another tenant". Any authenticated user can enumerate IDs and
 * distinguish the two responses.
 *
 * Most routes should use `getAccessibleResource` below, which wraps the
 * whole pattern. When composing manually (bespoke not-found responses),
 * the shape is:
 *
 *     const issue = await svc.getById(id);
 *     if (!issue || !hasCompanyAccess(req, issue.companyId)) {
 *       res.status(404).json({ error: "Issue not found" });
 *       return;
 *     }
 *
 * so both "does not exist" and "exists but cross-tenant" return the same
 * 404, removing the oracle.
 *
 * Note: this intentionally does not replicate the write-path membership
 * checks in `assertCompanyAccess` (active membership, viewer read-only).
 * Routes that need those checks for authorized tenants should still call
 * `assertCompanyAccess` after the 404 gate — the oracle concern is only
 * about the existence check.
 *
 * The company-scope semantics must stay in lockstep with
 * `assertCompanyAccess`: in particular, signed-in instance admins do NOT
 * get blanket access to companies they are not a member of.
 */
export function hasCompanyAccess(req: Request, companyId: string): boolean {
  if (req.actor.type === "none") return false;
  if (req.actor.type === "agent") return req.actor.companyId === companyId;
  if (req.actor.source === "local_implicit") return true;
  return (req.actor.companyIds ?? []).includes(companyId);
}

/**
 * Preferred way to fetch a company-scoped resource by id inside a route
 * handler. Wraps the two-step pattern described on `hasCompanyAccess` so
 * new routes cannot accidentally reintroduce the existence oracle:
 *
 *   - missing resource          → 404 `{ error: notFoundMessage }`, returns null
 *   - exists but cross-tenant   → identical 404, returns null
 *   - accessible                → runs `assertCompanyAccess` (write-path
 *     membership checks on non-safe methods) and returns the resource
 *
 * Usage:
 *
 *     const goal = await getAccessibleResource(req, res, svc.getById(id), "Goal not found");
 *     if (!goal) return;
 *
 * Routes with bespoke not-found behavior (legacy `200 []` contracts,
 * audit-logged denials) should still compose `hasCompanyAccess` directly.
 */
export async function getAccessibleResource<T extends { companyId: string }>(
  req: Request,
  res: Response,
  resource: T | null | undefined | Promise<T | null | undefined>,
  notFoundMessage: string,
): Promise<T | null> {
  const resolved = await resource;
  if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
    res.status(404).json({ error: notFoundMessage });
    return null;
  }
  assertCompanyAccess(req, resolved.companyId);
  return resolved;
}

export function getActorInfo(req: Request): (
  {
    actorType: "agent";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId: string | null;
    actorSource: "agent_key" | "agent_jwt";
  }
  | {
    actorType: "user";
    actorId: string;
    sessionId: string | null;
    agentId: null;
    runId: string | null;
    agentApiKeyId: null;
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
      agentApiKeyId: req.actor.keyId ?? null,
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
    sessionId: req.actor.sessionId ?? null,
    agentId: null,
    runId: req.actor.runId ?? null,
    agentApiKeyId: null,
    actorSource,
  };
}
