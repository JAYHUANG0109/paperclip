/**
 * Per-space access control for LLM-Wiki spaces — the PURE decision primitive.
 *
 * Mirrors the skill-folder ACL model (`folderScopeVisible` in
 * server/src/services/folders.ts): shared → everyone; personal → owner only;
 * team → team members; privileged viewers (owner/admin/instance-admin/local
 * implicit) see everything.
 *
 * This module is intentionally PURE and side-effect free so it can be unit
 * tested in isolation and reused wherever a space is resolved. It is NOT yet
 * wired into the read/write path — enforcement requires threading an actor into
 * the plugin worker (incl. the getData transport, which carries no actor today)
 * and resolving the privileged flag host-side. See
 * doc/WIKI-SPACE-ACCESS-PLAN.md for the sequenced enforcement steps.
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
  accessScope: string; // "shared" | "personal" | "team" (unknown → fail closed)
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
