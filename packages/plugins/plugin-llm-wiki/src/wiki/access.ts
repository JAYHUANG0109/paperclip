/**
 * Per-space access control for LLM-Wiki spaces — the PURE decision primitive.
 *
 * Mirrors the skill-folder ACL model (`folderScopeVisible` in
 * server/src/services/folders.ts): shared → everyone; personal → owner only;
 * team → team members; privileged viewers (owner/admin/instance-admin/local
 * implicit) see everything.
 *
 * This module is intentionally PURE and side-effect free so it can be unit
 * tested in isolation and reused wherever a space is resolved.
 *
 * Enforcement IS live. The host resolves the viewer from `req.actor` (never from
 * caller params) and injects it as `__pcViewer` on all four transports —
 * getData, performAction, onApiRequest and tool execution (see
 * `resolvePluginViewer` / `injectPluginViewer` / `resolvePluginToolViewer` in
 * server/src/routes/plugins.ts). Only the event-ingestion path stays viewer-less
 * and trusted, by design.
 *
 * For an acting agent the injected `userId` is the agent's MAPPED user (its
 * direct agent_memberships join), not whoever triggered the run, and
 * `isPrivileged` is always false. See doc/WIKI-SPACE-ACCESS-PLAN.md.
 */

export type WikiSpaceViewer = {
  /** Acting human user id, if the caller is a user (or the user backing an agent). */
  userId?: string | null;
  /** Acting agent id, if the caller is an agent. */
  agentId?: string | null;
  /** owner / admin / instance-admin / local-implicit board → sees ALL spaces. */
  isPrivileged?: boolean;
  /** Team keys the viewer belongs to (for team-scoped spaces). */
  teams?: readonly string[];
};

/** The subset of a WikiSpace needed to decide visibility. */
export type SpaceAccessFields = {
  accessScope: string; // "shared" | "admin" | "personal" | "team" (unknown → fail closed)
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
  teamKey?: string | null;
  slug?: string;
};

/**
 * Pure per-space visibility check. Fails CLOSED for unknown scopes (treated as
 * private → owner only), so a mis-set scope never leaks.
 */
export function spaceScopeVisible(space: SpaceAccessFields, viewer: WikiSpaceViewer): boolean {
  if (viewer.isPrivileged) return true;
  const scope = (space.accessScope || "shared").toLowerCase();
  if (scope === "shared") return true;
  // The company wiki: admins only. Privileged viewers already returned true
  // above, so this denies everyone else outright — including a space's own
  // owner, and including agents, which is the point. Unlike leaving the scope
  // unknown and leaning on the fail-closed branch below, this says so out loud,
  // so nobody later "fixes" an unrecognised scope by making it shared.
  if (scope === "admin") return false;

  const ownedByUser = !!viewer.userId && !!space.ownerUserId && space.ownerUserId === viewer.userId;
  const ownedByAgent = !!viewer.agentId && !!space.ownerAgentId && space.ownerAgentId === viewer.agentId;

  if (scope === "personal") return ownedByUser || ownedByAgent;
  if (scope === "team") {
    const inTeam = !!space.teamKey && (viewer.teams ?? []).includes(space.teamKey);
    return ownedByUser || ownedByAgent || inTeam;
  }
  // Unknown/misconfigured scope → fail closed: only the owner may see it.
  return ownedByUser || ownedByAgent;
}

/** Throwing guard for use at each space-scoped entry point once actor threading lands. */
export function assertSpaceAccess(space: SpaceAccessFields, viewer: WikiSpaceViewer): void {
  if (!spaceScopeVisible(space, viewer)) {
    throw new Error(`Access denied to wiki space${space.slug ? ` "${space.slug}"` : ""}.`);
  }
}
