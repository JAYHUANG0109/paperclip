/**
 * 資訊部 (IT department) agent-edit policy — PURE decision logic.
 *
 * Rule (per Jay, 2026-07): a 資訊部 user may edit ANY agent EXCEPT the admin tier
 * (founder 唐富美, 惠君, and Jay's own agent). Company owner / instance-admin
 * (Jay) keep full access via the existing `allow_instance_admin` rule — this
 * policy only WIDENS access for 資訊部, never narrows anyone's.
 *
 * Grantee = in the explicit email allowlist (option 1) OR a member of a 資訊部
 * team (option 3 — inert until a team model exists; wired via getUserTeams).
 *
 * NOTE(config): these identities are Seasonarts-specific and live in code only
 * as a first implementation. They should move to a company-scoped config
 * (agentEditorEmails[] / protectedAgentIds[]) so the platform stays multi-tenant.
 * This module is PURE + unit-tested; wiring into the authorization engine
 * (actor email/team resolution + loadAgent owner + the allow-rule) is separate.
 */

/** 資訊部 users granted edit access (option 1: explicit allowlist). */
export const IT_EDITOR_USER_EMAILS: readonly string[] = [
  "it-jessica@seasonart.org",
  "a0000960@seasonart.org", // 偉誠 資訊副理
  "a0001030@seasonart.org", // 張育銘 資訊軟體組長
  "a0001186@seasonart.org", // 林智偉 資訊工程師
  "a0001151@seasonart.org", // 賴忠泰 資訊工程師
  "a0000409@seasonart.org", // 黃坤源 資訊硬體組長
];

/** 資訊部 team keys (option 3): grantee if a member of one of these teams. */
export const IT_EDITOR_TEAM_KEYS: readonly string[] = ["資訊部", "IT", "information"];

/** Admin-tier agents 資訊部 must NOT edit — by agent id (robust; covers Jay who has no owner email). */
export const PROTECTED_AGENT_IDS: readonly string[] = [
  "593fa24b-96dd-4c76-aca1-44ea8dd784ac", // 創辦人_tang (founder 唐富美)
  "08c1ba71-698a-4839-81cd-bd0f2dadaf4e", // 何惠君_人才發展
  "7e1a0853-38f2-4a2f-ac5b-69247c1a350c", // Jay_jay20020109
];

/** Extra protection by owner email (belt-and-suspenders for founder/惠君 across re-provisioning). */
export const PROTECTED_OWNER_EMAILS: readonly string[] = [
  "tang@seasonart.org",
  "betty1@seasonart.org",
];

export type EditorActor = { email?: string | null; teams?: readonly string[] | null };
export type TargetAgent = { agentId: string; ownerEmail?: string | null };

function lc(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}

/** True if the acting user is a 資訊部 editor (allowlist OR 資訊部 team member). */
export function isItDepartmentEditor(actor: EditorActor): boolean {
  const email = lc(actor.email);
  if (email && IT_EDITOR_USER_EMAILS.some((e) => e.toLowerCase() === email)) return true;
  const teamSet = new Set(IT_EDITOR_TEAM_KEYS.map((t) => t.toLowerCase()));
  return (actor.teams ?? []).some((t) => teamSet.has(String(t).trim().toLowerCase()));
}

/** True if the target agent is in the protected admin tier (must not be edited by 資訊部). */
export function isProtectedAgent(target: TargetAgent): boolean {
  if (PROTECTED_AGENT_IDS.includes(target.agentId)) return true;
  const owner = lc(target.ownerEmail);
  return !!owner && PROTECTED_OWNER_EMAILS.some((e) => e.toLowerCase() === owner);
}

/**
 * The policy: a 資訊部 editor may edit any agent EXCEPT a protected admin-tier one.
 * Returns false for non-editors (they fall through to the other authz rules).
 */
export function itEditorMayEditAgent(actor: EditorActor, target: TargetAgent): boolean {
  return isItDepartmentEditor(actor) && !isProtectedAgent(target);
}
