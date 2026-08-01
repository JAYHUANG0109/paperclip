/**
 * Agent ownership config policy — PURE decision logic.
 *
 * `adapterConfig.assignedUserEmail` and `adapterConfig.assignedUserRole` look
 * like adapter settings but are really authorization grants. At sign-in,
 * `autoProvisionAssignedAgents` (server/src/auth/better-auth.ts) matches the
 * signed-in Google email against `assignedUserEmail` and, for every match,
 * grants that user:
 *
 *   - a `company_memberships` row at `assignedUserRole` (default "operator"),
 *   - an `agent_memberships` row, which is what `getVisibleAgentIdsForUser`
 *     reads to decide which agents (and, transitively, which tasks) they see,
 *   - and, when the requested role is "owner", an `instance_user_roles` row
 *     with role `instance_admin`.
 *
 * So whoever can write these two keys decides who owns an agent and how much
 * power they get. Before this policy existed, `PATCH /agents/:id` required only
 * company membership, which meant any operator could tag an agent — their own
 * would do — with `{assignedUserEmail: <self>, assignedUserRole: "owner"}` and
 * return from the next sign-in as an instance admin.
 *
 * Two rules, both enforced here:
 *
 *  1. Only a company owner/admin may CHANGE these keys; agent-authenticated
 *     callers never may (an agent must not be able to re-home itself).
 *  2. Omitting them must not clear them. Callers PATCH the whole adapterConfig
 *     back, so a write that simply lacks the keys has to be read as "unchanged",
 *     not "unlink this agent from its owner" — which would revoke that person's
 *     access at their next sign-in.
 *
 * This module is PURE + unit-tested; the route wiring lives in
 * server/src/routes/agents.ts.
 */
import { AGENT_OWNERSHIP_CONFIG_KEYS } from "@paperclipai/shared";

export type OwnershipActor = {
  /** `agent` = agent key/JWT; `board`/`user` = a signed-in human; `none` = unauthenticated. */
  actorType: string;
  /** Company owner/admin, instance admin, or the local implicit board. */
  isPrivileged: boolean;
};

/** Compare the way the sign-in matcher does, so casing/padding is not a "change". */
function normalizeOwnershipValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function hasKey(record: Record<string, unknown> | null | undefined, key: string): boolean {
  return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Which ownership keys this write would actually change, as dotted paths.
 *
 * A key counts as changed only when it is present in the request AND its
 * normalized value differs from what is stored. Echoing the stored value back
 * is not a change — that is what lets an operator keep editing everything else
 * on an agent they do not own.
 */
export function agentOwnershipConfigChanges(
  requested: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null | undefined,
  path = "adapterConfig",
): string[] {
  if (!requested) return [];
  return AGENT_OWNERSHIP_CONFIG_KEYS
    .filter((key) => hasKey(requested, key)
      && normalizeOwnershipValue(requested[key]) !== normalizeOwnershipValue(existing?.[key]))
    .map((key) => `${path}.${key}`);
}

/**
 * True if this actor is allowed to change agent ownership at all.
 *
 * Allowlists the one actor type that can be a company admin rather than
 * denying known-bad ones. `board` is the only type a signed-in human has
 * (`"board" | "agent" | "none"`); an `agent` must never re-home itself, and
 * `none` must never pass.
 *
 * The allowlist matters because `isPrivileged` is supplied by
 * `isPrivilegedMemberViewer`, which reports EVERY non-board actor as
 * privileged. Testing `isPrivileged` alone would therefore wave through an
 * unauthenticated caller. Nothing reaches this today without passing
 * `hasCompanyAccess` first (which rejects `none`), but a rule this consequential
 * should not depend on a check somewhere else staying in place.
 */
export function mayChangeAgentOwnership(actor: OwnershipActor): boolean {
  if (actor.actorType !== "board") return false;
  return actor.isPrivileged;
}

/**
 * Remove ownership keys from an adapter config, reporting what was dropped.
 *
 * For paths that build an agent from caller-supplied data without going through
 * the route guard — company import being the case that matters, since it both
 * creates and updates agents from a manifest and is reachable by any non-viewer
 * member. Ownership is also an instance-local fact (it names an account on THIS
 * instance), so carrying it across an export/import boundary is wrong on its own
 * terms, quite apart from the escalation it would allow.
 */
export function stripAgentOwnershipConfig(
  adapterConfig: Record<string, unknown>,
): { adapterConfig: Record<string, unknown>; stripped: string[] } {
  const next = { ...adapterConfig };
  const stripped: string[] = [];
  for (const key of AGENT_OWNERSHIP_CONFIG_KEYS) {
    if (hasKey(next, key)) {
      delete next[key];
      stripped.push(key);
    }
  }
  return { adapterConfig: next, stripped };
}

/**
 * Carry ownership keys forward when a write omits them.
 *
 * Clearing one therefore takes an explicit value (an explicit null), never an
 * omission — and an explicit value is a change, so it must pass
 * `mayChangeAgentOwnership` first.
 */
export function preserveAgentOwnershipConfig(
  existingAdapterConfig: Record<string, unknown>,
  nextAdapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...nextAdapterConfig };
  for (const key of AGENT_OWNERSHIP_CONFIG_KEYS) {
    if (!hasKey(merged, key) && existingAdapterConfig[key] !== undefined) {
      merged[key] = existingAdapterConfig[key];
    }
  }
  return merged;
}
