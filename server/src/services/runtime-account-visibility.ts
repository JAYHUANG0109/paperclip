/**
 * Who may see which provider account the platform is currently running on —
 * PURE decision logic.
 *
 * Per Jay (2026-08): the founder and 惠君 (admin tier) plus 數位資訊部 need to
 * be able to answer "which Claude account is Paperclip on right now?" without
 * being handed runtime control. This is READ-ONLY visibility into the
 * credential-rotation pool; it never implies the ability to change accounts.
 *
 * Grantee = instance admin / local board, OR a privileged company role
 * (owner/admin), OR a 資訊部 member (reusing the allowlist in
 * ./agent-edit-policy.js so the department is defined in exactly one place),
 * OR anyone holding an explicit `runtime:view_accounts` grant.
 *
 * The explicit grant is the extensible path: it is in the owner/admin role
 * defaults and can be handed to anyone from the Company Access page, so adding
 * a person later needs no code change. The role and 資訊部 clauses exist so the
 * people who already need this do NOT have to be back-filled with grant rows.
 *
 * NOTE(config): the 資訊部 identities this leans on are Seasonarts-specific and
 * still live in code — see the same note in ./agent-edit-policy.js.
 */
import { isItDepartmentEditor } from "./agent-edit-policy.js";

export type RuntimeAccountViewer = {
  /** Instance admin or the implicit local board actor. */
  isInstanceAdmin?: boolean;
  /** Company membership role, if the actor is a member. */
  membershipRole?: string | null;
  /** The actor's email, used for the 資訊部 allowlist. */
  email?: string | null;
  /** Whether the actor holds an explicit `runtime:view_accounts` grant. */
  hasExplicitGrant?: boolean;
};

function isPrivilegedCompanyRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export function mayViewRuntimeAccounts(viewer: RuntimeAccountViewer): boolean {
  if (viewer.isInstanceAdmin) return true;
  if (isPrivilegedCompanyRole(viewer.membershipRole)) return true;
  if (viewer.hasExplicitGrant) return true;
  return isItDepartmentEditor({ email: viewer.email, teams: [] });
}

/** Why the actor was allowed — surfaced in the API so access stays auditable. */
export function runtimeAccountViewerReason(viewer: RuntimeAccountViewer): string | null {
  if (viewer.isInstanceAdmin) return "instance_admin";
  if (isPrivilegedCompanyRole(viewer.membershipRole)) return "company_admin";
  if (viewer.hasExplicitGrant) return "explicit_grant";
  if (isItDepartmentEditor({ email: viewer.email, teams: [] })) return "it_department";
  return null;
}
