import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentMemberships,
  authUsers,
  companyMemberships,
  companySecretBindings,
  heartbeatRuns,
  instanceUserRoles,
  activityLog,
  issueComments,
  issues,
  principalPermissionGrants,
  projectAccessMembers,
  projects,
  routineAccessMembers,
  userInboxAgentPolicies,
} from "@paperclipai/db";
import type {
  AgentApiKeyScope,
  InboxAgentPolicyMode,
  PermissionKey,
  PrincipalType,
  SkillTestAgentKeyScope,
  TaskBridgeAgentKeyScope,
} from "@paperclipai/shared";
import { LOW_TRUST_REVIEW_PRESET, extractAgentMentionIds, anyTeamTokenMatches, type LowTrustBoundary } from "@paperclipai/shared";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  isIssueWithinLowTrustBoundary,
  resolveCoreTrustPreset,
  type TrustPresetResolution,
} from "./trust-preset-resolver.js";
import { itEditorMayEditAgent } from "./agent-edit-policy.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { logger } from "../middleware/logger.js";

export type AuthorizationActor =
  {
    type: "board" | "agent" | "none";
    userId?: string | null;
    sessionId?: string | null;
    companyIds?: string[];
    memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
    onBehalfOfMemberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
    isInstanceAdmin?: boolean;
    ignoreInstanceAdmin?: boolean;
    agentId?: string | null;
    companyId?: string | null;
    keyId?: string | null;
    keyScope?: AgentApiKeyScope | null;
    runId?: string | null;
    onBehalfOfUserId?: string | null;
    source?:
      | "local_implicit"
      | "session"
      | "board_key"
      | "agent_key"
      | "agent_jwt"
      | "cloud_tenant"
      | "none";
  };

export type AuthorizationAction =
  | PermissionKey
  | "agent_config:read"
  | "agent_config:update"
  | "skill_config:update"
  | "agent:read"
  | "agent:wake"
  | "company_scope:read"
  | "decision_queue:manage"
  | "decision_queue:read"
  | "decision_triage:manage"
  | "issue:comment"
  | "issue:mutate"
  | "issue:read"
  | "project:read"
  | "runtime:manage"
  | "secrets:read";

/**
 * The actions the 四季 member restriction applies to.
 *
 * ONE list, used in two places that must never disagree: the branch in
 * `decide()` that consults `restrictedMemberCanRead`, and the exhaustive switch
 * inside it. Before this existed the two were separate literals, so an action
 * could be added to the gate and never decided — which is exactly how
 * `secrets:read` came to be readable by a restricted member.
 *
 * Adding an action here is deliberately a breaking change: the code will not
 * compile until `restrictedMemberCanRead` says what it means for someone who
 * only sees their own corner of the company.
 */
export const RESTRICTABLE_ACTIONS = [
  "agent:read",
  "company_scope:read",
  // Decision queues/triage are restrictable for the same reason the reads are: an
  // agent-scoped actor must not see another agent's queue. Upstream listed these
  // inline at the call site; this fork keeps one source of truth, so they go here.
  "decision_queue:manage",
  "decision_queue:read",
  "decision_triage:manage",
  "issue:read",
  "project:read",
  "runtime:manage",
  "secrets:read",
] as const;

export type RestrictableAction = (typeof RESTRICTABLE_ACTIONS)[number];

export function isRestrictableAction(action: AuthorizationAction): action is RestrictableAction {
  return (RESTRICTABLE_ACTIONS as readonly string[]).includes(action);
}

export type AuthorizationResource =
  | { type: "company"; companyId: string }
  /**
   * A specific secret.
   *
   * `secrets:read` used to be decided against the whole company, which meant the
   * only answers available were "all of them" or "none". Naming the secret is
   * what makes "your own bound secrets, and nothing else" expressible.
   *
   * `secretId` stays optional so a caller asking the general question ("may this
   * actor read secrets at all?") is still representable — the restricted rule
   * treats an unnamed secret as unanswerable and refuses it.
   *
   * `targetAgentId` covers the one legitimate unnamed case: listing the secrets
   * bound to ONE agent. That caller filters to that agent's own bindings itself,
   * so the question is "may this person see this agent's secrets" rather than
   * "which secret", and refusing it would break an agent enumerating its own.
   */
  | {
      type: "secret";
      companyId: string;
      secretId?: string | null;
      targetAgentId?: string | null;
    }
  | { type: "agent"; companyId: string; agentId?: string | null }
  | { type: "project"; companyId: string; projectId?: string | null }
  | {
      type: "issue";
      companyId: string;
      issueId?: string | null;
      projectId?: string | null;
      parentIssueId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
      originKind?: string | null;
      originId?: string | null;
      status?: string | null;
    };

export type AuthorizationDecision = {
  allowed: boolean;
  action: AuthorizationAction;
  explanation: string;
  inboxPolicyMode?: InboxAgentPolicyMode | "grant_override";
  code?: "RESPONSIBLE_USER_UNAUTHORIZED" | "RESPONSIBLE_USER_UNAVAILABLE";
  reason:
    | "allow_low_trust_boundary"
    | "allow_local_board"
    | "allow_instance_admin"
    | "allow_explicit_grant"
    | "allow_direct_change"
    | "allow_consented_change"
    | "allow_legacy_agent_creator"
    | "allow_issue_mention_grant"
    | "allow_direct_parent_report"
    | "allow_visible_issue_write"
    | "allow_self"
    | "allow_company_agent"
    | "allow_company_member"
    | "allow_simple_company_member"
    | "allow_manager_chain"
    | "allow_it_department_editor"
    | "inbox_target_user_unresolved"
    | "inbox_management_disabled"
    | "inbox_agent_not_allowed"
    | "deny_unauthenticated"
    | "deny_company_boundary"
    | "deny_missing_membership"
    | "deny_missing_grant"
    | "deny_missing_consent"
    | "deny_no_grant"
    | "deny_policy_restricted"
    | "deny_low_trust_boundary"
    | "deny_scope"
    | "deny_unsupported_action";
  grant?: {
    principalType: PrincipalType;
    principalId: string;
    permissionKey: PermissionKey;
    scope: Record<string, unknown> | null;
  };
};

type PrincipalGrantDecision = AuthorizationDecision & {
  grant?: NonNullable<AuthorizationDecision["grant"]>;
};

function companyIdForResource(resource: AuthorizationResource) {
  return resource.companyId;
}

function permissionForAction(action: AuthorizationAction): PermissionKey | null {
  if (action === "agent_config:read" || action === "agent_config:update" || action === "skill_config:update") {
    return null;
  }
  if (
    action === "agent:read" ||
    action === "agent:wake" ||
    action === "company_scope:read" ||
    action === "decision_queue:manage" ||
    action === "decision_queue:read" ||
    action === "decision_triage:manage" ||
    action === "issue:read" ||
    action === "project:read" ||
    action === "runtime:manage" ||
    action === "secrets:read"
  ) {
    return null;
  }
  if (action === "issue:comment" || action === "issue:mutate") return null;
  return action;
}

function canCreateAgentsLegacy(agent: { role: string; permissions: unknown }) {
  if (agent.role === "ceo") return true;
  if (!agent.permissions || typeof agent.permissions !== "object") return false;
  return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
}

function scopeValueList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function prefixedScopeValues(grantScope: Record<string, unknown>, prefix: string) {
  return scopeValueList(grantScope.allow)
    .filter((rule) => rule.startsWith(prefix))
    .map((rule) => rule.slice(prefix.length))
    .filter((value) => value.length > 0);
}

function scopeValuesForKeys(grantScope: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => scopeValueList(grantScope[key]));
}

function scopeIncludesId(ids: string[], id: string | null | undefined) {
  return Boolean(id && ids.includes(id));
}

function isSimpleAssignableAgentStatus(status: string | null | undefined) {
  return status !== "pending_approval" && status !== "terminated";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectIsEmpty(value: Record<string, unknown>) {
  return Object.keys(value).length === 0;
}

function readPolicyObject(container: unknown, key: string): Record<string, unknown> | null {
  if (!isPlainRecord(container)) return null;
  const value = container[key];
  return isPlainRecord(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type AssignmentPolicyEffect =
  | { kind: "none" }
  | { kind: "restricted"; explanation: string }
  | { kind: "requires_approval"; explanation: string }
  | { kind: "unknown"; explanation: string };

type AgentHierarchyRow = { id: string; reportsTo: string | null };
type LowTrustBoundaryWithCompany = LowTrustBoundary & { companyId: string };
type AgentAuthorizationRow = {
  id: string;
  companyId: string;
  role: string;
  status: string;
  reportsTo: string | null;
  permissions: Record<string, unknown> | null | undefined;
};
type ProjectAuthorizationRow = {
  id: string;
  companyId: string;
  executionWorkspacePolicy: unknown;
};
type IssueAuthorizationRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  status: string;
  executionPolicy: unknown;
  originKind: string | null;
  originId: string | null;
};

function evaluateAuthorizationPolicyForAssignment(
  policy: Record<string, unknown> | null | undefined,
  label: string,
): AssignmentPolicyEffect {
  if (!policy || objectIsEmpty(policy)) return { kind: "none" };

  const agentVisibility = readPolicyObject(policy, "agentVisibility");
  const assignmentPolicy = readPolicyObject(policy, "assignmentPolicy");
  const protectedAgent = readPolicyObject(policy, "protectedAgent");
  const knownTopLevelKeys = new Set([
    "agentVisibility",
    "assignmentPolicy",
    "protectedAgent",
    "managedBy",
  ]);
  const hasUnknownTopLevelKey = Object.keys(policy).some((key) => !knownTopLevelKeys.has(key));
  const hasKnownPolicySection = Boolean(agentVisibility || assignmentPolicy || protectedAgent);
  if (hasUnknownTopLevelKey || !hasKnownPolicySection) {
    return {
      kind: "unknown",
      explanation: `${label} has authorization policy data that core cannot evaluate for task assignment.`,
    };
  }

  const visibilityMode = readString(agentVisibility?.mode);
  if (visibilityMode && visibilityMode !== "discoverable" && visibilityMode !== "private") {
    return {
      kind: "unknown",
      explanation: `${label} has an unsupported agent visibility policy mode.`,
    };
  }

  const assignmentMode = readString(assignmentPolicy?.mode);
  if (assignmentMode && assignmentMode !== "company_default" && assignmentMode !== "protected") {
    return {
      kind: "unknown",
      explanation: `${label} has an unsupported assignment policy mode.`,
    };
  }

  const requiresApproval =
    readBoolean(protectedAgent?.requiresApproval) === true ||
    readBoolean(assignmentPolicy?.protectedAgentRequiresApproval) === true;
  if (requiresApproval) {
    return {
      kind: "requires_approval",
      explanation: `${label} requires approval before task assignment.`,
    };
  }

  if (
    visibilityMode === "private" ||
    readBoolean(agentVisibility?.hiddenFromDefaultDirectory) === true
  ) {
    return {
      kind: "restricted",
      explanation: `${label} is private and cannot use simple company-wide task assignment.`,
    };
  }

  if (assignmentMode === "protected") {
    return {
      kind: "restricted",
      explanation: `${label} is protected and requires an explicit assignment grant.`,
    };
  }

  return { kind: "none" };
}

function agentIsInSubtree(
  agentsById: Map<string, AgentHierarchyRow>,
  rootAgentId: string,
  targetAgentId: string,
) {
  if (rootAgentId === targetAgentId) return true;

  let cursor: string | null = targetAgentId;
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    const current = agentsById.get(cursor);
    if (!current) return false;
    if (current.reportsTo === rootAgentId) return true;
    cursor = current.reportsTo;
  }
  return false;
}

async function loadCompanyAgentHierarchy(db: Db, companyId: string) {
  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  return new Map(rows.map((agent) => [agent.id, agent]));
}

async function isAgentInSubtree(db: Db, companyId: string, rootAgentId: string, targetAgentId: string) {
  return agentIsInSubtree(
    await loadCompanyAgentHierarchy(db, companyId),
    rootAgentId,
    targetAgentId,
  );
}

async function scopeAllows(
  db: Db,
  companyId: string,
  grantScope: Record<string, unknown> | null,
  requestedScope: Record<string, unknown> | null | undefined,
  options: { requireStructuredScope?: boolean } = {},
) {
  if (!grantScope || Object.keys(grantScope).length === 0) return !options.requireStructuredScope;
  if (!requestedScope) return false;

  const targetAssigneeAgentId =
    typeof requestedScope.assigneeAgentId === "string"
      ? requestedScope.assigneeAgentId
      : typeof requestedScope.targetAgentId === "string"
        ? requestedScope.targetAgentId
        : null;
  const requestedProjectId = typeof requestedScope.projectId === "string" ? requestedScope.projectId : null;
  const requestedUserId = typeof requestedScope.userId === "string" ? requestedScope.userId : null;
  let constrained = false;

  const projectIds = [
    ...scopeValueList(grantScope.projectId),
    ...scopeValueList(grantScope.projectIds),
    ...prefixedScopeValues(grantScope, "project:"),
  ];
  if (projectIds.length > 0) {
    constrained = true;
    if (!scopeIncludesId(projectIds, requestedProjectId)) return false;
  }

  const targetAgentIds = [
    ...scopeValuesForKeys(grantScope, [
      "agentId",
      "agentIds",
      "assigneeAgentId",
      "assigneeAgentIds",
      "targetAgentId",
      "targetAgentIds",
    ]),
    ...prefixedScopeValues(grantScope, "agent:"),
  ];
  if (targetAgentIds.length > 0) {
    constrained = true;
    if (!scopeIncludesId(targetAgentIds, targetAssigneeAgentId)) return false;
  }

  const targetUserIds = scopeValuesForKeys(grantScope, ["userId", "userIds"]);
  if (targetUserIds.length > 0) {
    constrained = true;
    if (!scopeIncludesId(targetUserIds, requestedUserId)) return false;
  }

  const subtreeRootAgentIds = [
    ...scopeValuesForKeys(grantScope, [
      "managerAgentId",
      "managerAgentIds",
      "managedSubtreeAgentId",
      "managedSubtreeAgentIds",
      "subtreeAgentId",
      "subtreeAgentIds",
      "subtreeRootAgentId",
      "subtreeRootAgentIds",
    ]),
    ...prefixedScopeValues(grantScope, "subtree:"),
  ];
  if (subtreeRootAgentIds.length > 0) {
    constrained = true;
    if (!targetAssigneeAgentId) return false;
    const agentsById = await loadCompanyAgentHierarchy(db, companyId);
    let matchesSubtree = false;
    for (const rootAgentId of subtreeRootAgentIds) {
      if (agentIsInSubtree(agentsById, rootAgentId, targetAssigneeAgentId)) {
        matchesSubtree = true;
        break;
      }
    }
    if (!matchesSubtree) return false;
  }

  // Unknown metadata keys do not constrain the grant. Recognized constraints
  // return false above when they fail to match the requested assignment scope.
  return !constrained ? true : constrained;
}

function allow(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: true };
}

function deny(input: Omit<AuthorizationDecision, "allowed">): AuthorizationDecision {
  return { ...input, allowed: false };
}

// 四季 (Seasonarts) operator-visibility restriction, ported onto upstream's authz.
// When PAPERCLIP_RESTRICT_AGENT_VISIBILITY=true, a non-privileged board member
// (company role operator/member/viewer — i.e. NOT owner/admin, and not an
// instance admin or the local board) is scoped to: agents they have JOINED plus
// agents that transitively report to a joined agent, and issues assigned to them,
// assigned to a visible agent, or created by them. Default (flag off) keeps
// upstream's company-wide visibility unchanged.
function restrictAgentVisibilityEnabled(): boolean {
  return process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY === "true";
}

function projectPrivacyEnabled(): boolean {
  return process.env.PAPERCLIP_PROJECT_PRIVACY === "true";
}

/**
 * Infrastructure team tokens: agents tagged with one of these keep company-wide
 * reach even with no joined user.
 *
 * This encodes the intent already recorded against the unmapped-agent case —
 * "Infrastructure agents (系統自動化, built-ins) map to nobody… scoping them to an
 * empty set would silently break every automation on the platform." Built-ins are
 * recognised separately by their metadata marker; this token covers the other
 * legitimate case, an agent a PLUGIN manages, which carries no marker and is
 * otherwise indistinguishable from an ordinary unpaired agent. `Wiki Maintainer`
 * from plugin-llm-wiki is the live example, tagged 系統自動化 and nothing else.
 *
 * Same shape as leadershipTeamTokens: configurable per deployment, defaulting to
 * this instance's team name.
 */
/** The team labels on an agent row (metadata.teams, or a single metadata.team). */
function readAgentTeams(metadata: unknown): Set<string> {
  const md = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const arr = Array.isArray(md.teams) ? md.teams : typeof md.team === "string" ? [md.team] : [];
  const out = new Set<string>();
  for (const t of arr) if (typeof t === "string" && t.trim()) out.add(t.trim());
  return out;
}

function infrastructureTeamTokens(): Set<string> {
  const raw = process.env.PAPERCLIP_INFRASTRUCTURE_TEAM_TOKENS?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["系統自動化"];
  return new Set(list);
}

/**
 * Escape hatch for an unpaired agent that is neither built-in nor tagged as
 * infrastructure but still needs company-wide reach. Comma-separated UUIDs, empty
 * by default — reach is opted into deliberately rather than inherited by omission.
 */
function companyWideUnpairedAgentIds(): Set<string> {
  const raw = process.env.PAPERCLIP_COMPANY_WIDE_AGENT_IDS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// Narrower switch: enforce PROJECT-LIST visibility for humans (sidebar, project
// detail, and the agent 專案 tab via the viewer's filtered list) WITHOUT the riskier
// task-visibility + agent task-scoping that the full PAPERCLIP_PROJECT_PRIVACY brings.
// The full flag implies visibility.
function projectVisibilityEnabled(): boolean {
  return process.env.PAPERCLIP_PROJECT_VISIBILITY === "true" || projectPrivacyEnabled();
}

// Leadership team tokens: members of these teams (via metadata.teams) may read
// PRIVATE projects whose team tokens they also match — i.e. a campus/department
// head oversees the private projects of their own campus/dept, without exposing
// them to regular peers (who lack the leadership token). team-match on ordinary
// members still only grants `team`-visibility projects, never `private`.
// Configurable per deployment; defaults to this instance's "領導團隊".
function leadershipTeamTokens(): Set<string> {
  const raw = process.env.PAPERCLIP_LEADERSHIP_TEAM_TOKENS?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : ["領導團隊"];
  return new Set(list);
}

function isPrivilegedCompanyRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

type ResponsibleUserSnapshot = {
  userId: string;
  companyId: string;
  userExists: boolean;
  activeMembership: { companyId: string; membershipRole?: string | null; status?: string } | null;
};

type ResponsibleUserActorWithMemo = AuthorizationActor & {
  __responsibleUserSnapshotMemo?: Map<string, Promise<ResponsibleUserSnapshot>>;
};

const responsibleUserSnapshotCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ResponsibleUserSnapshot> }
>();

function responsibleUserSnapshotTtlMs() {
  const raw = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_CACHE_TTL_MS?.trim();
  if (!raw) return 5_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
}

export function responsibleUserAuthzShadowMode() {
  const mode = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE?.trim().toLowerCase();
  const shadow = process.env.PAPERCLIP_RESPONSIBLE_USER_AUTHZ_SHADOW?.trim().toLowerCase();
  return mode === "shadow" || shadow === "1" || shadow === "true" || shadow === "yes";
}

function activeActorMembership(
  memberships: Array<{ companyId: string; membershipRole?: string | null; status?: string }> | null | undefined,
  companyId: string,
) {
  return memberships?.find((membership) => membership.companyId === companyId && membership.status === "active") ?? null;
}

function activeResponsibleUserCanAuthorizeIssueAction(
  action: AuthorizationAction,
  membership: ResponsibleUserSnapshot["activeMembership"],
) {
  return Boolean(
    membership &&
    membership.status === "active" &&
    membership.membershipRole !== "viewer" &&
    (action === "issue:comment" || action === "issue:mutate")
  );
}

function activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(
  action: AuthorizationAction,
  membership: ResponsibleUserSnapshot["activeMembership"],
  agentDecision: AuthorizationDecision,
  actorAgentId: string | null | undefined,
) {
  return Boolean(
    action === "skill_config:update" &&
    membership &&
    membership.status === "active" &&
    membership.membershipRole !== "viewer" &&
    agentDecision.allowed &&
    (agentDecision.reason === "allow_direct_change" || agentDecision.reason === "allow_consented_change") &&
    agentDecision.grant?.principalType === "agent" &&
    agentDecision.grant.principalId === actorAgentId &&
    (agentDecision.grant.permissionKey === "skills:create" ||
      agentDecision.grant.permissionKey === "skills:suggest-changes"),
  );
}

function scopeBoolean(scope: Record<string, unknown> | null | undefined, key: string) {
  return scope?.[key] === true;
}

export function authorizationDeniedDetails(decision: AuthorizationDecision) {
  return {
    ...(decision.code ? { code: decision.code } : {}),
    reason: decision.reason,
  };
}

export function authorizationService(db: Db) {
  // Visible agent set for a restricted member: joined agents + their reports-to
  // subtree (manager-of-a-joined-agent style). Empty when the user joined none.
  async function getVisibleAgentIdsForUser(companyId: string, userId: string): Promise<Set<string>> {
    const joinedRows = await db
      .select({ agentId: agentMemberships.agentId })
      .from(agentMemberships)
      .where(
        and(
          eq(agentMemberships.companyId, companyId),
          eq(agentMemberships.userId, userId),
          eq(agentMemberships.state, "joined"),
        ),
      );
    const visible = new Set(joinedRows.map((r) => r.agentId));
    if (visible.size === 0) return visible;
    const allAgents = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const childrenByManager = new Map<string, string[]>();
    for (const a of allAgents) {
      if (!a.reportsTo) continue;
      const list = childrenByManager.get(a.reportsTo) ?? [];
      list.push(a.id);
      childrenByManager.set(a.reportsTo, list);
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
   * Per-item visibility decision for a restricted member.
   *
   * TOTAL by construction: it returns a boolean for every action in
   * `RESTRICTABLE_ACTIONS`, and the exhaustiveness check at the bottom makes
   * adding an action to that list without deciding it a COMPILE error.
   *
   * That totality is the point of this function's shape. It used to return
   * `boolean | null`, where `null` meant "fall through to the standard
   * membership rule" — and the standard rule is *allow any active member*. So
   * the effective policy was "a restricted member is denied only what somebody
   * remembered to deny", and every action added to the gate list afterwards
   * defaulted to company-wide. Three had accumulated: `project:read`,
   * `runtime:manage` and `secrets:read`, the last of which resolves actual
   * secret VALUES (services/secrets.ts).
   *
   * A default that fails open produces one new leak per feature and cannot be
   * audited, because nothing records which actions were considered. Deciding
   * every case explicitly costs one line per action and moves the discovery
   * from production to the type checker.
   */
  async function restrictedMemberCanRead(
    action: RestrictableAction,
    companyId: string,
    userId: string,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    if (action === "company_scope:read") return false; // force per-item filtering

    if (action === "secrets:read") return restrictedMemberCanReadSecret(companyId, userId, resource);

    /**
     * Runtime control, scoped to the project the workspace belongs to.
     *
     * When the caller names a project this is the same question as reading it:
     * a member who works in a project may start and stop the runtime for its
     * workspaces, and may not touch anybody else's. That reuses the project rule
     * rather than inventing a second notion of "your work".
     *
     * A caller that names no project is asking the company-wide question, which
     * for someone scoped to their own corner is refused — there is no such thing
     * as "all the runtime in the company" that belongs to them.
     */
    if (action === "runtime:manage") {
      if (resource.type === "project" && resource.projectId) {
        return restrictedMemberCanReadProject(companyId, userId, resource);
      }
      /**
       * An agent's own runtime. The issue-monitor path asks this, and its own
       * check below is narrower still — only the ASSIGNEE agent or a board user
       * gets through — so the question here is just "is this an agent in your
       * world", which is the same visibility rule used everywhere else.
       */
      if (resource.type === "agent" && resource.agentId) {
        return (await getVisibleAgentIdsForUser(companyId, userId)).has(resource.agentId);
      }
      return false;
    }

    if (action === "project:read") return restrictedMemberCanReadProject(companyId, userId, resource);

    /**
     * Decision queues and triage, scoped per item rather than at this gate.
     *
     * The routes only ever ask the company-level question -- assertDecisionAccess
     * passes `{ type: "company" }`, never a queue or decision -- so there is nothing
     * here to narrow against, and denying would close the desk even for decisions
     * raised by the member's OWN agents.
     *
     * The narrowing is real, one layer down: decisionQueueService.visibleItems
     * filters every row through canReadDecisionSource, which resolves the item to
     * its issue and asks `issue:read` -- restricted above to visible agents and own
     * issues. Items with no issue (join requests, unlinked approvals, budget
     * incidents) additionally require a board actor plus `company_scope:read`,
     * which this function refuses. So a scoped member sees their agents' proposals
     * and nothing else.
     *
     * Same shape as the `issue:read` branch below: allow the general question,
     * narrow per item. Revisit if a route ever authorizes a NAMED queue or decision.
     */
    if (
      action === "decision_queue:read" ||
      action === "decision_queue:manage" ||
      action === "decision_triage:manage"
    ) {
      return true;
    }

    if (action === "agent:read") {
      const agentId = resource.type === "agent" ? resource.agentId : null;
      const visible = await getVisibleAgentIdsForUser(companyId, userId);
      return Boolean(agentId && visible.has(agentId));
    }
    if (action === "issue:read") {
      const issueId = resource.type === "issue" ? resource.issueId : null;
      // No issue named: the caller is asking whether this person reads issues at
      // all, not whether they may read a particular one. Answering "no" here
      // would close the task list entirely; the narrowing happens per item, and
      // `company_scope:read` above already refuses the company-wide shortcut.
      // This preserves the behaviour the old `null` fall-through produced, now
      // stated rather than inherited.
      if (!issueId) return true;
      const issue = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdByUserId: issues.createdByUserId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) return false;
      if (issue.assigneeUserId === userId || issue.createdByUserId === userId) return true;

      const visible = await getVisibleAgentIdsForUser(companyId, userId);
      if (visible.size === 0) return false;
      if (issue.assigneeAgentId && visible.has(issue.assigneeAgentId)) return true;
      // A task your agent raised is yours to see — this is the Google Chat
      // case, where the agent files the task and is not its assignee.
      if (issue.createdByAgentId && visible.has(issue.createdByAgentId)) return true;

      // Otherwise fall back to participation: your agent commented on it or
      // acted on it. Requiring ASSIGNMENT left people staring at an empty task
      // page while their agent page listed the same work, because onboarding
      // and chat-raised tasks are participated in rather than assigned.
      //
      // One extra query, and only for issues the cheap checks did not settle.
      const agentIds = [...visible];
      const participated = await db
        .select({ one: sql<number>`1` })
        .from(issues)
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.companyId, companyId),
            sql`(
              EXISTS (
                SELECT 1 FROM ${issueComments}
                WHERE ${issueComments.issueId} = ${issues.id}
                  AND ${issueComments.companyId} = ${companyId}
                  AND ${issueComments.authorAgentId} IN ${agentIds}
              )
              OR EXISTS (
                SELECT 1 FROM ${activityLog}
                WHERE ${activityLog.companyId} = ${companyId}
                  AND ${activityLog.entityType} = 'issue'
                  AND ${activityLog.entityId} = ${issues.id}::text
                  AND ${activityLog.agentId} IN ${agentIds}
              )
            )`,
          ),
        )
        .limit(1);
      return participated.length > 0;
    }

    // Exhaustiveness. If a new action joins RESTRICTABLE_ACTIONS without a
    // branch above, `action` is no longer `never` and this line fails to
    // compile — which is the entire mechanism. Do not replace it with a
    // `return false`: a silent deny is easier to ship than a stated one, and
    // the point is to force the decision to be made and written down.
    const exhaustive: never = action;
    void exhaustive;
    return false;
  }

  /**
   * Which secrets a restricted member may read.
   *
   * Per-secret, not per-company. The first cut of this restriction denied
   * `secrets:read` outright, which was safe but wrong in a way that would have
   * been discovered as "the platform is broken": a shared credential is not
   * theirs to read, but the token bound to their OWN agent plainly is — it is how
   * their agent talks to Asana on their behalf.
   *
   * A secret is theirs if it is bound to an agent they can see, or to a project
   * they can read. `company_secret_bindings.target_type/target_id` is the same
   * table the runtime projection uses to decide what to hand a run, so this
   * agrees with reality by construction rather than by a parallel rule.
   *
   * An unnamed secret is refused. "May you read secrets in general?" has no
   * per-secret answer, and the honest response for someone scoped to their own
   * corner is no — every real read names the secret it wants.
   */
  async function restrictedMemberCanReadSecret(
    companyId: string,
    userId: string,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    const secretId = resource.type === "secret" ? resource.secretId ?? null : null;
    const targetAgentId = resource.type === "secret" ? resource.targetAgentId ?? null : null;

    // Enumerating ONE agent's secrets. The caller restricts itself to that
    // agent's bindings, so the only question left is whether this person may see
    // that agent at all.
    if (!secretId && targetAgentId) {
      const visible = await getVisibleAgentIdsForUser(companyId, userId);
      return visible.has(targetAgentId);
    }

    if (!secretId) return false;

    const bindings = await db
      .select({
        targetType: companySecretBindings.targetType,
        targetId: companySecretBindings.targetId,
      })
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.secretId, secretId),
        ),
      );
    if (bindings.length === 0) return false;

    const agentTargets = bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId);
    if (agentTargets.length > 0) {
      const visible = await getVisibleAgentIdsForUser(companyId, userId);
      if (agentTargets.some((agentId) => visible.has(agentId))) return true;
    }

    const projectTargets = bindings.filter((b) => b.targetType === "project").map((b) => b.targetId);
    for (const projectId of projectTargets) {
      if (await restrictedMemberCanReadProject(companyId, userId, { type: "project", companyId, projectId })) {
        return true;
      }
    }

    return false;
  }

  /**
   * The restriction as it applies to an AGENT actor, via its mapped user.
   *
   * Returns null for "not applicable — keep company-wide visibility", which is
   * the right answer in three genuinely different situations:
   *
   *   • The agent maps to nobody. Infrastructure and built-ins (系統自動化) have
   *     no person's world to be scoped to, and scoping them to an empty set
   *     would silently break the automation everyone depends on.
   *
   *   • The agent maps to SEVERAL people. There is no single scope to apply and
   *     picking one would be a guess about whose data this agent may see.
   *
   *   • The mapped user is privileged. Their own reach is company-wide, so
   *     narrowing their agent below their own access would be incoherent.
   *
   * Everything else delegates to `restrictedMemberCanRead` — one policy, two
   * actor types. Two copies of this rule would drift, and the drift would be
   * invisible until someone noticed an agent seeing more than its owner.
   */
  /**
   * Scope for an agent with NO joined user, under the 四季 restriction.
   *
   * There is no human whose visibility it can inherit, so it gets exactly its own
   * work: itself, tasks assigned to or raised by it, and projects it has work in.
   *
   * This exists because the previous behaviour was fail-OPEN. `restrictedAgentActorCanRead`
   * returned `null` ("no opinion") whenever an agent was not paired 1:1 with a
   * non-privileged user, and `null` falls through to the company-wide allow. That
   * was tolerable while writes needed an ownership/parent/mention grant of their
   * own; once upstream made issue writes default-open on top of `issue:read`
   * (59edc71fd), read reach became write reach, so an unpaired agent could comment
   * on and assign any company-visible task.
   *
   * Mirrors the member rules deliberately: `company_scope:read` is refused to force
   * per-item filtering, and a question that names no issue/project is allowed for
   * the same reason it is for members — answering "no" would empty the list rather
   * than narrow it.
   */
  async function restrictedUnpairedAgentCanRead(
    action: RestrictableAction,
    companyId: string,
    actorAgentId: string,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    if (action === "company_scope:read") return false;

    // No user behind this agent, so there is no one whose secrets it could be
    // acting for. The paired case resolves this through the user's declarations.
    if (action === "secrets:read") return false;

    if (action === "agent:read") {
      const agentId = resource.type === "agent" ? resource.agentId : null;
      return agentId === actorAgentId;
    }

    if (action === "runtime:manage") {
      // Its own runtime only. A caller naming no agent is asking the company-wide
      // question, which does not exist for an agent scoped to itself.
      if (resource.type === "agent" && resource.agentId) return resource.agentId === actorAgentId;
      if (resource.type === "project" && resource.projectId) {
        return agentHasWorkInProject(companyId, actorAgentId, resource.projectId);
      }
      return false;
    }

    if (action === "project:read") {
      const projectId = resource.type === "project" ? resource.projectId : null;
      if (!projectId) return true; // list question; routes filter per item
      return agentHasWorkInProject(companyId, actorAgentId, projectId);
    }

    if (action === "issue:read") {
      const issueId = resource.type === "issue" ? resource.issueId : null;
      if (!issueId) return true; // list question; routes filter per item
      const issue = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          createdByAgentId: issues.createdByAgentId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) return false;
      if (issue.assigneeAgentId === actorAgentId || issue.createdByAgentId === actorAgentId) return true;

      /**
       * The thread its own work belongs to, not just the single task.
       *
       * Two clauses, both required by behaviour that already exists:
       *
       * - DIRECT PARENT. An agent reports upward by commenting on the parent of
       *   the task it was given; the low-trust red-team suite pins this as
       *   "preserves direct-parent reporting". Scoping to the exact task only
       *   would silence every child agent's report.
       * - PARTICIPATION. It already commented on or acted on the task. The member
       *   rule carries the same clause, for the same reason: onboarding and
       *   chat-raised tasks are participated in rather than assigned, and
       *   requiring assignment leaves an agent unable to read a thread it is
       *   demonstrably already in.
       *
       * Both are strictly narrower than the company-wide reach this replaces.
       */
      // Same task TREE as work of its own: parent, grandparent, sibling, cousin.
      // Upstream's default-open contract deliberately extends to the surrounding
      // tree, not just the exact task — the low-trust suite asserts a standard
      // agent may comment on the reviewGrandparent and on a sameBoundaryChild
      // sibling. Comparing root ancestors keeps that while still refusing every
      // OTHER tree in the company, which is the reach actually being removed.
      if (await agentSharesIssueTree(companyId, actorAgentId, issueId)) return true;

      const participated = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.agentId, actorAgentId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return Boolean(participated);
    }

    return false;
  }

  /**
   * Is the named issue in the same task tree as any work of this agent's own?
   *
   * "Tree" is the whole family, resolved by walking each side up to its root
   * ancestor and comparing: parent, grandparent, sibling and cousin all match,
   * while an unrelated tree does not. A recursive CTE does the walk in one query
   * rather than N round trips, and `cycle` guards a malformed parent loop from
   * hanging the request.
   */
  async function agentSharesIssueTree(
    companyId: string,
    actorAgentId: string,
    issueId: string,
  ): Promise<boolean> {
    const rows = await db.execute(sql`
      with recursive up as (
        select id, parent_id from issues
         where id = ${issueId} and company_id = ${companyId}
        union all
        select i.id, i.parent_id from issues i
          join up on i.id = up.parent_id
         where i.company_id = ${companyId}
      ),
      target_root as (
        select id from up where parent_id is null limit 1
      ),
      mine as (
        select id, parent_id from issues
         where company_id = ${companyId}
           and (assignee_agent_id = ${actorAgentId} or created_by_agent_id = ${actorAgentId})
        union all
        select i.id, i.parent_id from issues i
          join mine on i.id = mine.parent_id
         where i.company_id = ${companyId}
      )
      select 1 as hit
        from mine
        join target_root on target_root.id = mine.id
       where mine.parent_id is null
       limit 1
    `);
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    return list.length > 0;
  }

  /** Does this agent have any task in the named project? */
  async function agentHasWorkInProject(
    companyId: string,
    actorAgentId: string,
    projectId: string,
  ): Promise<boolean> {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.projectId, projectId),
          or(eq(issues.assigneeAgentId, actorAgentId), eq(issues.createdByAgentId, actorAgentId)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function restrictedAgentActorCanRead(
    action: RestrictableAction,
    companyId: string,
    actorAgentId: string,
    resource: AuthorizationResource,
  ): Promise<boolean | null> {
    const memberships = await db
      .select({ userId: agentMemberships.userId })
      .from(agentMemberships)
      .where(
        and(
          eq(agentMemberships.companyId, companyId),
          eq(agentMemberships.agentId, actorAgentId),
          eq(agentMemberships.state, "joined"),
        ),
      );

    const userIds = [...new Set(memberships.map((row) => row.userId).filter(Boolean))];

    if (userIds.length === 0) {
      // Built-in agents (Reflection Coach, Summarizer) are cross-cutting by
      // design — Reflection Coach reads other agents' runs to coach them, the
      // Summarizer reads the tasks it summarizes — so they keep company-wide
      // reach, recognised by their metadata marker rather than a list.
      const agentRow = await db
        .select({ metadata: agents.metadata })
        .from(agents)
        .where(and(eq(agents.id, actorAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (agentRow && readBuiltInAgentMarker(agentRow.metadata)) return null;
      // Plugin-managed infrastructure (Wiki Maintainer) carries no built-in
      // marker, only its team tag. anyTeamTokenMatches takes (tokens, teams), so
      // the infrastructure tokens are the needles and the agent's teams the set.
      if (agentRow && anyTeamTokenMatches([...infrastructureTeamTokens()], readAgentTeams(agentRow.metadata))) {
        return null;
      }
      if (companyWideUnpairedAgentIds().has(actorAgentId)) return null;

      // Everything else with no joined user is scoped to its own work. This is
      // the fail-closed half: previously this returned null and inherited
      // company-wide reach purely by omission.
      return restrictedUnpairedAgentCanRead(action, companyId, actorAgentId, resource);
    }

    // More than one joined user is left as "no opinion" deliberately: the right
    // answer is the UNION of those users' scopes, and inventing a narrower rule
    // here would silently shrink a shared agent's view. No live agent is in this
    // state; revisit with a real case to model against.
    if (userIds.length !== 1) return null;
    const mappedUserId = userIds[0] as string;

    const membership = await getActiveMembership(companyId, "user", mappedUserId);
    if (!membership || isPrivilegedCompanyRole(membership.membershipRole)) return null;

    return restrictedMemberCanRead(action, companyId, mappedUserId, resource);
  }

  /**
   * Which projects a restricted member may read.
   *
   * Scoped rather than denied outright. `project:read` decides the project
   * sidebar and every project page, so a blanket denial would empty the
   * platform for exactly the people the restriction is meant to keep working
   * normally — and a security change that makes the product unusable gets
   * turned off, which protects nobody.
   *
   * A project is theirs if they own it, if they are an explicit member of it,
   * or if they or one of their visible agents actually has work in it. That
   * last clause is what makes this invisible in normal use: you see the
   * projects you work in, and stop seeing the ones you never touch.
   *
   * A project-less resource is allowed: the caller is asking about "projects"
   * in general rather than about one project, and the per-item filter
   * (routes/projects.ts `filterProjectsForActor`) is what narrows the list.
   */
  async function restrictedMemberCanReadProject(
    companyId: string,
    userId: string,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    const projectId =
      resource.type === "project"
        ? resource.projectId ?? null
        : resource.type === "issue"
          ? resource.projectId ?? null
          : null;
    if (!projectId) return true;

    const project = await db
      .select({
        ownerUserId: projects.ownerUserId,
        visibility: projects.visibility,
        teams: projects.teams,
        team: projects.team,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!project) return false;
    if (project.ownerUserId === userId) return true;

    const explicitMember = await db
      .select({ one: sql<number>`1` })
      .from(projectAccessMembers)
      .where(
        and(
          eq(projectAccessMembers.projectId, projectId),
          eq(projectAccessMembers.principalType, "user"),
          eq(projectAccessMembers.principalId, userId),
        ),
      )
      .limit(1);
    if (explicitMember.length > 0) return true;

    /**
     * Team sharing. Without this, tagging a project `team: 數位資訊部` granted
     * NOTHING — the New Project dialog offers "團隊專案（可選多個團隊）" and the
     * members panel says 所屬團隊成員均可存取, but only an owner, an explicit member,
     * or somebody with work in the project could actually read it.
     *
     * The rule already existed in decideProjectVisibility; it was simply
     * unreachable, because under the 四季 restriction this function answers first
     * and totally and never falls through to it. Rather than invent a second
     * semantic, mirror that one exactly:
     *   - `team` project    → any member whose team token matches;
     *   - `private` project → only a LEADERSHIP member whose token matches, so a
     *     campus/department head oversees their own area's private projects while
     *     regular peers on the same team still cannot.
     *
     * Matching is by token, so a sub-team project tagged [campus, sub] is covered
     * by the head's campus token, including sub-teams created later. A campus is
     * deliberately NOT expanded to its children: names like 幼教學組 repeat across
     * campuses, so expanding would leak sibling campuses' projects.
     */
    const projectTeams = (project.teams && project.teams.length > 0)
      ? project.teams
      : (project.team ? [project.team] : []);
    if (projectTeams.length > 0 && (project.visibility === "team" || project.visibility === "private")) {
      const actorTeams = await resolveActorTeams(companyId, { type: "board", userId, source: "session" });
      if (actorTeams.size > 0 && anyTeamTokenMatches(projectTeams, actorTeams)) {
        if (project.visibility === "team") return true;
        const leadership = leadershipTeamTokens();
        for (const token of actorTeams) if (leadership.has(token)) return true;
      }
    }

    const visible = await getVisibleAgentIdsForUser(companyId, userId);
    const agentIds = [...visible];
    const worked = await db
      .select({ one: sql<number>`1` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.projectId, projectId),
          agentIds.length > 0
            ? or(
              eq(issues.assigneeUserId, userId),
              eq(issues.createdByUserId, userId),
              inArray(issues.assigneeAgentId, agentIds),
              inArray(issues.createdByAgentId, agentIds),
            )
            : or(eq(issues.assigneeUserId, userId), eq(issues.createdByUserId, userId)),
        ),
      )
      .limit(1);
    return worked.length > 0;
  }

  // ---- Phase 5: project privacy ----
  // When PAPERCLIP_PROJECT_PRIVACY=true, projects with visibility='private' are only
  // readable by: company owners/admins, instance admins, the project's ownerUserId,
  // and explicit project_access_members. Everything else is denied.

  async function getProjectVisibility(projectId: string, companyId: string) {
    return db
      .select({ visibility: projects.visibility, ownerUserId: projects.ownerUserId, team: projects.team, teams: projects.teams })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
  }

  // The team labels an actor belongs to (from agent metadata.teams): for an agent
  // actor, its own teams; for a board/user actor, the union across the agents they
  // have joined. Basis for `team`-visibility project access.
  async function resolveActorTeams(companyId: string, actor: AuthorizationActor): Promise<Set<string>> {
    const out = new Set<string>();
    const collect = (metadata: unknown) => {
      const md = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
      const arr = Array.isArray(md.teams) ? md.teams : typeof md.team === "string" ? [md.team] : [];
      for (const t of arr) if (typeof t === "string" && t.trim()) out.add(t.trim());
    };
    if (actor.type === "agent" && actor.agentId) {
      const row = await db.select({ metadata: agents.metadata }).from(agents)
        .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (row) collect(row.metadata);
    } else if (actor.type === "board" && actor.userId) {
      const rows = await db.select({ metadata: agents.metadata })
        .from(agents)
        .innerJoin(agentMemberships, eq(agentMemberships.agentId, agents.id))
        .where(and(
          eq(agentMemberships.companyId, companyId),
          eq(agentMemberships.userId, actor.userId),
          eq(agentMemberships.state, "joined"),
        ));
      for (const r of rows) collect(r.metadata);
    }
    return out;
  }

  async function isProjectMember(projectId: string, principalType: "user" | "agent", principalId: string) {
    return db
      .select({ id: projectAccessMembers.id })
      .from(projectAccessMembers)
      .where(
        and(
          eq(projectAccessMembers.projectId, projectId),
          eq(projectAccessMembers.principalType, principalType),
          eq(projectAccessMembers.principalId, principalId),
        ),
      )
      .then((rows) => rows.length > 0);
  }

  // Returns true=allow, false=deny, null=not a scoped project (fall through).
  // Covers BOTH `private` (owner + explicit members) and `team` (owner + explicit
  // members + anyone whose team matches the project's team). `company` and legacy
  // visibilities fall through (null) to the normal company-wide decision.
  async function decidePrivateProjectRead(
    action: string,
    companyId: string,
    projectId: string | null | undefined,
    actor: AuthorizationActor,
    membershipRole: string | null | undefined,
  ): Promise<boolean | null> {
    // Gate by what's enabled: a human's `project:read` (the project list/detail) is
    // gated by the narrow visibility flag; a human's `issue:read` (task visibility)
    // and ALL agent scoping require the full privacy flag. So the visibility flag
    // hides projects from people without touching tasks or agents.
    const enabled = actor.type === "agent"
      ? projectPrivacyEnabled()
      : action === "project:read"
        ? projectVisibilityEnabled()
        : projectPrivacyEnabled();
    if (!enabled || !projectId) return null;
    const proj = await getProjectVisibility(projectId, companyId);
    if (!proj || (proj.visibility !== "private" && proj.visibility !== "team")) return null;
    // Owners/admins and instance admins always see scoped projects.
    if (isPrivilegedCompanyRole(membershipRole)) return true;
    if (actor.type === "board") {
      if (actor.source === "local_implicit" || actor.isInstanceAdmin) return true;
      if (actor.userId && proj.ownerUserId === actor.userId) return true; // owner
      if (actor.userId && await isProjectMember(projectId, "user", actor.userId)) return true; // explicit member
    } else if (actor.type === "agent" && actor.agentId) {
      if (await isProjectMember(projectId, "agent", actor.agentId)) return true; // explicit member
    }
    // Team visibility (multi-team; falls back to the legacy single `team` label):
    //  - `team` projects  → ANY actor whose team matches.
    //  - `private` projects → ONLY a leadership actor (a member of a leadership
    //    team) whose team matches — so campus/department heads can oversee the
    //    private projects of their OWN campus/dept, while regular peers (who lack
    //    the leadership token) still cannot see them.
    {
      const projectTeams = (proj.teams && proj.teams.length > 0) ? proj.teams : (proj.team ? [proj.team] : []);
      if (projectTeams.length > 0) {
        const teams = await resolveActorTeams(companyId, actor);
        if (teams.size > 0 && anyTeamTokenMatches(projectTeams, teams)) {
          if (proj.visibility === "team") return true;
          // Private: only a leadership actor (campus/dept head) may read, and only
          // when a team token matches — i.e. a project in their own campus/dept.
          // Sub-team projects carry [parent, sub] (parent = campus/dept), so the
          // head's parent token matches every sub-team, INCLUDING future ones,
          // automatically. We deliberately do NOT expand a campus to its child
          // sub-teams: sub-team names (幼教學組, ESL教學組, …) are shared across
          // campuses, so expansion would leak siblings' private projects.
          if (proj.visibility === "private") {
            const leadership = leadershipTeamTokens();
            for (const t of teams) if (leadership.has(t)) return true;
          }
        }
      }
    }
    return false;
  }

  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    if (
      await db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null)
    ) {
      return true;
    }
    return false;
  }

  async function getActiveMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function loadResponsibleUserSnapshot(companyId: string, userId: string): Promise<ResponsibleUserSnapshot> {
    const [user, membership] = await Promise.all([
      db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);
    return {
      userId,
      companyId,
      userExists: Boolean(user),
      activeMembership: user ? membership : null,
    };
  }

  function getResponsibleUserSnapshot(input: {
    actor: AuthorizationActor;
    companyId: string;
    userId: string;
  }): Promise<ResponsibleUserSnapshot> {
    const actorWithMemo = input.actor as ResponsibleUserActorWithMemo;
    const key = `${input.companyId}:${input.userId}`;
    actorWithMemo.__responsibleUserSnapshotMemo ??= new Map();
    const requestMemo = actorWithMemo.__responsibleUserSnapshotMemo.get(key);
    if (requestMemo) return requestMemo;

    const actorMembership = input.actor.onBehalfOfUserId === input.userId
      ? activeActorMembership(input.actor.onBehalfOfMemberships, input.companyId)
      : null;
    if (actorMembership) {
      const promise = Promise.resolve({
        userId: input.userId,
        companyId: input.companyId,
        userExists: true,
        activeMembership: actorMembership,
      });
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, promise);
      return promise;
    }

    const now = Date.now();
    const cached = responsibleUserSnapshotCache.get(key);
    if (cached && cached.expiresAt > now) {
      actorWithMemo.__responsibleUserSnapshotMemo.set(key, cached.promise);
      return cached.promise;
    }

    const ttlMs = responsibleUserSnapshotTtlMs();
    const promise = loadResponsibleUserSnapshot(input.companyId, input.userId);
    if (ttlMs > 0) {
      responsibleUserSnapshotCache.set(key, { expiresAt: now + ttlMs, promise });
      promise.catch(() => {
        if (responsibleUserSnapshotCache.get(key)?.promise === promise) {
          responsibleUserSnapshotCache.delete(key);
        }
      });
    }
    actorWithMemo.__responsibleUserSnapshotMemo.set(key, promise);
    return promise;
  }

  async function findGrant(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function decidePrincipalGrant(input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    action: AuthorizationAction;
    permissionKey: PermissionKey;
    scope?: Record<string, unknown> | null;
  }): Promise<PrincipalGrantDecision> {
    const membership = await getActiveMembership(input.companyId, input.principalType, input.principalId);
    if (!membership) {
      return deny({
        action: input.action,
        reason: "deny_missing_membership",
        explanation: `${input.principalType} principal ${input.principalId} is not an active member of company ${input.companyId}.`,
      });
    }

    const grant = await findGrant(input.companyId, input.principalType, input.principalId, input.permissionKey);
    if (!grant) {
      return deny({
        action: input.action,
        reason: "deny_missing_grant",
        explanation: `Missing permission: ${input.permissionKey}.`,
      });
    }

    if (
      !(await scopeAllows(db, input.companyId, grant.scope, input.scope, {
        requireStructuredScope: input.permissionKey === "tasks:assign_scope",
      }))
    ) {
      return deny({
        action: input.action,
        reason: "deny_scope",
        explanation: `Permission ${input.permissionKey} does not cover the requested scope.`,
        grant: {
          principalType: input.principalType,
          principalId: input.principalId,
          permissionKey: input.permissionKey,
          scope: grant.scope ?? null,
        },
      });
    }

    return allow({
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: `Allowed by explicit grant ${input.permissionKey}.`,
      grant: {
        principalType: input.principalType,
        principalId: input.principalId,
        permissionKey: input.permissionKey,
        scope: grant.scope ?? null,
      },
    });
  }

  async function loadUserEmail(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    const rows = await db.select({ email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId));
    return rows[0]?.email ?? null;
  }

  async function loadAgentOwnerEmail(agentId: string): Promise<string | null> {
    const rows = await db.select({ cfg: agents.adapterConfig }).from(agents).where(eq(agents.id, agentId));
    const cfg = (rows[0]?.cfg ?? null) as Record<string, unknown> | null;
    const email = cfg?.assignedUserEmail;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  }

  async function loadAgent(agentId: string): Promise<AgentAuthorizationRow | null> {
    return db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadProject(projectId: string): Promise<ProjectAuthorizationRow | null> {
    return db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        executionWorkspacePolicy: projects.executionWorkspacePolicy,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadIssue(issueId: string): Promise<IssueAuthorizationRow | null> {
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        status: issues.status,
        executionPolicy: issues.executionPolicy,
        originKind: issues.originKind,
        originId: issues.originId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function loadRunPolicy(runId: string | null | undefined, companyId: string, agentId: string) {
    if (!runId) return null;
    const row = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId || row.agentId !== agentId) return null;
    const context = isPlainRecord(row.contextSnapshot) ? row.contextSnapshot : null;
    return isPlainRecord(context?.executionPolicy)
      ? { companyId: row.companyId, executionPolicy: context.executionPolicy }
      : null;
  }

  async function loadRunIssueId(runId: string | null | undefined, companyId: string, agentId: string) {
    if (!runId) return null;
    const row = await db
      .select({
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId || row.agentId !== agentId) return null;
    const context = isPlainRecord(row.contextSnapshot) ? row.contextSnapshot : null;
    const issueId = typeof context?.issueId === "string"
      ? context.issueId.trim()
      : typeof context?.taskId === "string"
        ? context.taskId.trim()
        : "";
    return issueId || null;
  }

  async function isDirectParentReportTarget(input: {
    actor: AuthorizationActor;
    actorAgentId: string;
    companyId: string;
    resource: AuthorizationResource;
  }) {
    if (input.resource.type !== "issue" || !input.resource.issueId) return false;
    const runIssueId = await loadRunIssueId(input.actor.runId, input.companyId, input.actorAgentId);
    if (!runIssueId || runIssueId === input.resource.issueId) return false;
    const runIssue = await loadIssue(runIssueId);
    return Boolean(
      runIssue &&
      runIssue.companyId === input.companyId &&
      runIssue.assigneeAgentId === input.actorAgentId &&
      runIssue.checkoutRunId === input.actor.runId &&
      runIssue.parentId === input.resource.issueId,
    );
  }

  async function loadProjectAuthorizationPolicy(companyId: string, projectId: string) {
    const row = await db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return readPolicyObject(row?.executionWorkspacePolicy, "authorizationPolicy");
  }

  async function loadIssueAuthorizationPolicy(companyId: string, issueId: string) {
    const row = await db
      .select({ executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    return readPolicyObject(row?.executionPolicy, "authorizationPolicy");
  }

  async function loadResourceContext(resource: AuthorizationResource) {
    const issue = resource.type === "issue" && resource.issueId ? await loadIssue(resource.issueId) : null;
    const projectId =
      resource.type === "issue"
        ? issue?.projectId ?? resource.projectId ?? null
        : resource.type === "project"
          ? resource.projectId ?? null
          : null;
    const project = projectId ? await loadProject(projectId) : null;
    return { issue, project };
  }

  async function resolveActorTrust(input: {
    actorAgent: AgentAuthorizationRow;
    actor: AuthorizationActor;
    companyId: string;
    resource: AuthorizationResource;
  }): Promise<TrustPresetResolution> {
    const { issue, project } = await loadResourceContext(input.resource);
    const run = await loadRunPolicy(input.actor.runId, input.companyId, input.actorAgent.id);
    return resolveCoreTrustPreset({
      companyId: input.companyId,
      agent: input.actorAgent,
      project,
      issue,
      run,
    });
  }

  async function issueIdIsDescendantOf(issueId: string, rootIssueId: string, companyId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND ancestors.depth < ${LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH - 1}
      )
      SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${rootIssueId}) AS is_descendant
    `);
    const first = Array.isArray(rows) ? rows[0] : null;
    return Boolean(
      first &&
        typeof first === "object" &&
        (first as Record<string, unknown>).is_descendant === true,
    );
  }

  async function issueResourceWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    resource: Extract<AuthorizationResource, { type: "issue" }>,
  ) {
    const issue = resource.issueId ? await loadIssue(resource.issueId) : null;
    const candidate = {
      companyId: resource.companyId,
      id: issue?.id ?? resource.issueId ?? null,
      projectId: issue?.projectId ?? resource.projectId ?? null,
    };
    if (isIssueWithinLowTrustBoundary(boundary, candidate)) return true;
    if (candidate.id && boundary.rootIssueId) {
      return issueIdIsDescendantOf(candidate.id, boundary.rootIssueId, boundary.companyId);
    }
    if (!resource.parentIssueId) return false;
    const parent = await loadIssue(resource.parentIssueId);
    if (!parent) return false;
    if (
      isIssueWithinLowTrustBoundary(boundary, {
        companyId: parent.companyId,
        id: parent.id,
        projectId: parent.projectId,
      })
    ) {
      return true;
    }
    return boundary.rootIssueId
      ? issueIdIsDescendantOf(parent.id, boundary.rootIssueId, boundary.companyId)
      : false;
  }

  async function projectWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    projectId: string | null | undefined,
  ) {
    if (!projectId) return false;
    if (boundary.projectIds?.includes(projectId)) return true;
    if (!boundary.rootIssueId) return false;
    const rootIssue = await loadIssue(boundary.rootIssueId);
    return rootIssue?.companyId === boundary.companyId && rootIssue.projectId === projectId;
  }

  function agentWithinLowTrustBoundary(
    boundary: LowTrustBoundaryWithCompany,
    actorAgentId: string,
    targetAgentId: string | null | undefined,
  ) {
    if (!targetAgentId) return false;
    return targetAgentId === actorAgentId || Boolean(boundary.allowedAgentIds?.includes(targetAgentId));
  }

  async function decideLowTrustAccess(input: {
    actorAgentId: string;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    resolution: TrustPresetResolution;
    directParentReportTarget: boolean;
  }): Promise<AuthorizationDecision | null> {
    if (input.resolution.kind === "standard") return null;
    if (input.resolution.kind === "denied") {
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation: input.resolution.detail,
      });
    }

    const boundary = input.resolution.boundary;
    const lowTrustDeny = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_low_trust_boundary",
        explanation,
      });
    const lowTrustAllow = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_low_trust_boundary",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "decision_queue:manage" ||
      input.action === "decision_queue:read" ||
      input.action === "decision_triage:manage" ||
      input.action === "agent_config:read" ||
      input.action === "agent_config:update" ||
      input.action === "skill_config:update" ||
      input.action === "inbox:manage" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return lowTrustDeny(
        `${LOW_TRUST_REVIEW_PRESET} agents cannot use company-wide or privileged ${input.action} APIs by default.`,
      );
    }

    if (input.action === "agent:read" || input.action === "agent:wake") {
      if (input.resource.type !== "agent") {
        return lowTrustDeny("Low-trust agent action is missing an agent resource.");
      }
      return agentWithinLowTrustBoundary(boundary, input.actorAgentId, input.resource.agentId)
        ? lowTrustAllow("Allowed inside the low-trust agent boundary.")
        : lowTrustDeny("Agent is outside this low-trust boundary.");
    }

    if (input.action === "project:read") {
      const projectId =
        input.resource.type === "issue"
          ? input.resource.projectId
          : input.resource.type === "project"
            ? input.resource.projectId
            : null;
      return await projectWithinLowTrustBoundary(boundary, projectId)
        ? lowTrustAllow("Allowed inside the low-trust project boundary.")
        : lowTrustDeny("Project is outside this low-trust boundary.");
    }

    if (input.action === "issue:comment" || input.action === "issue:read" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return lowTrustDeny("Low-trust issue access is missing an issue resource.");
      }
      if (input.action === "issue:comment" && input.directParentReportTarget) {
        if (
          input.resource.issueId &&
          await agentHasMentionGrantOnIssue({
            action: input.action,
            companyId: boundary.companyId,
            issueId: input.resource.issueId,
            issueAssigneeAgentId: input.resource.assigneeAgentId ?? null,
            actorAgentId: input.actorAgentId,
          })
        ) {
          return allowIssueMentionGrant(input.action);
        }
        return lowTrustDeny("Direct-parent report comments are disabled for low-trust review runs.");
      }
      if (await issueResourceWithinLowTrustBoundary(boundary, input.resource)) {
        return lowTrustAllow("Allowed inside the low-trust issue boundary.");
      }
      if (
        input.action !== "issue:mutate" &&
        input.resource.issueId &&
        await agentHasMentionGrantOnIssue({
          action: input.action,
          companyId: boundary.companyId,
          issueId: input.resource.issueId,
          issueAssigneeAgentId: input.resource.assigneeAgentId ?? null,
          actorAgentId: input.actorAgentId,
        })
      ) {
        return allowIssueMentionGrant(input.action);
      }
      return lowTrustDeny("Issue is outside this low-trust boundary.");
    }

    if (input.action === "tasks:assign") {
      if (input.resource.type !== "issue") {
        return lowTrustDeny("Low-trust task assignment is missing an issue resource.");
      }
      if (!(await issueResourceWithinLowTrustBoundary(boundary, input.resource))) {
        return lowTrustDeny("Task target is outside this low-trust boundary.");
      }
      if (input.resource.assigneeUserId) {
        return lowTrustDeny("Low-trust agents cannot assign work to board users.");
      }
      if (
        input.resource.assigneeAgentId &&
        !agentWithinLowTrustBoundary(boundary, input.actorAgentId, input.resource.assigneeAgentId)
      ) {
        return lowTrustDeny("Assignee agent is outside this low-trust boundary.");
      }
      return null;
    }

    return null;
  }

  function taskBridgeScopeIds(
    scope: TaskBridgeAgentKeyScope,
    singularKey: "projectId" | "parentIssueId",
    pluralKey: "projectIds" | "parentIssueIds",
  ) {
    return [
      ...(typeof scope[singularKey] === "string" ? [scope[singularKey]] : []),
      ...(Array.isArray(scope[pluralKey]) ? scope[pluralKey] : []),
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
  }

  async function parentIssueMatchesTaskBridgeBoundary(
    parentIssueId: string | null | undefined,
    companyId: string,
    allowedParentIssueIds: string[],
  ) {
    if (!parentIssueId || allowedParentIssueIds.length === 0) return false;
    if (allowedParentIssueIds.includes(parentIssueId)) return true;
    for (const rootIssueId of allowedParentIssueIds) {
      if (await issueIdIsDescendantOf(parentIssueId, rootIssueId, companyId)) return true;
    }
    return false;
  }

  async function issueMatchesTaskBridgeCreateBoundary(
    scope: TaskBridgeAgentKeyScope,
    resource: Extract<AuthorizationResource, { type: "issue" }>,
  ) {
    const allowedProjectIds = taskBridgeScopeIds(scope, "projectId", "projectIds");
    const allowedParentIssueIds = taskBridgeScopeIds(scope, "parentIssueId", "parentIssueIds");
    if (resource.projectId && allowedProjectIds.includes(resource.projectId)) return true;
    if (await parentIssueMatchesTaskBridgeBoundary(resource.parentIssueId, resource.companyId, allowedParentIssueIds)) {
      return true;
    }
    if (resource.parentIssueId && allowedProjectIds.length > 0) {
      const parent = await loadIssue(resource.parentIssueId);
      if (parent?.companyId === resource.companyId && parent.projectId && allowedProjectIds.includes(parent.projectId)) {
        return true;
      }
    }
    return false;
  }

  async function issueMatchesTaskBridgeWriteBoundary(input: {
    actorAgentId: string;
    keyId: string;
    resource: Extract<AuthorizationResource, { type: "issue" }>;
  }) {
    const issue = input.resource.issueId ? await loadIssue(input.resource.issueId) : null;
    const assigneeAgentId = issue?.assigneeAgentId ?? input.resource.assigneeAgentId ?? null;
    if (assigneeAgentId === input.actorAgentId) return true;
    const originKind = issue?.originKind ?? input.resource.originKind ?? null;
    const originId = issue?.originId ?? input.resource.originId ?? null;
    return originKind === "task_bridge" && originId === input.keyId;
  }

  async function decideTaskBridgeAccess(input: {
    actorAgentId: string;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope: TaskBridgeAgentKeyScope;
    keyId: string;
  }): Promise<AuthorizationDecision | null> {
    const denyBridge = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_scope",
        explanation,
      });
    const allowBridge = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_explicit_grant",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "decision_queue:manage" ||
      input.action === "decision_queue:read" ||
      input.action === "decision_triage:manage" ||
      input.action === "agent:read" ||
      input.action === "agent:wake" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return denyBridge("Task bridge keys cannot use company-wide, peer-agent, project, runtime, or secret APIs.");
    }

    if (input.action === "tasks:assign") {
      if (input.resource.type !== "issue") {
        return denyBridge("Task bridge assignment requires an issue resource.");
      }
      if (!(await issueMatchesTaskBridgeCreateBoundary(input.scope, input.resource))) {
        return denyBridge("Task bridge key is outside its approved parent or project boundary.");
      }
      if (input.resource.assigneeUserId) {
        return denyBridge("Task bridge keys cannot assign work to board users.");
      }
      const allowedAssigneeAgentIds = input.scope.allowedAssigneeAgentIds ?? [];
      if (
        input.resource.assigneeAgentId &&
        input.resource.assigneeAgentId !== input.actorAgentId &&
        !allowedAssigneeAgentIds.includes(input.resource.assigneeAgentId)
      ) {
        return denyBridge("Task bridge key cannot assign work to that agent.");
      }
      return allowBridge("Allowed by task bridge create boundary.");
    }

    if (input.action === "issue:read" || input.action === "issue:comment" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return denyBridge("Task bridge issue access requires an issue resource.");
      }
      return await issueMatchesTaskBridgeWriteBoundary({
        actorAgentId: input.actorAgentId,
        keyId: input.keyId,
        resource: input.resource,
      })
        ? allowBridge("Allowed for bridge-created or assigned issue.")
        : denyBridge("Task bridge key can only access assigned or bridge-created issues.");
    }

    return denyBridge("Task bridge key cannot use this API action.");
  }

  function decideSkillTestAccess(input: {
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope: SkillTestAgentKeyScope;
  }): AuthorizationDecision | null {
    const denySkillTest = (explanation: string) =>
      deny({
        action: input.action,
        reason: "deny_scope",
        explanation,
      });
    const allowSkillTest = (explanation: string) =>
      allow({
        action: input.action,
        reason: "allow_explicit_grant",
        explanation,
      });

    if (
      input.action === "company_scope:read" ||
      input.action === "decision_queue:manage" ||
      input.action === "decision_queue:read" ||
      input.action === "decision_triage:manage" ||
      input.action === "agent:read" ||
      input.action === "agent:wake" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read" ||
      input.action === "tasks:assign"
    ) {
      return denySkillTest("Skill-test run tokens cannot use company-wide, peer-agent, project, runtime, secret, or task-create APIs.");
    }

    if (input.action === "issue:read" || input.action === "issue:comment" || input.action === "issue:mutate") {
      if (input.resource.type !== "issue") {
        return denySkillTest("Skill-test issue access requires an issue resource.");
      }
      return input.resource.issueId === input.scope.issueId
        ? allowSkillTest("Allowed for the scoped skill-test issue.")
        : denySkillTest("Skill-test run token can only access its own harness issue.");
    }

    return denySkillTest("Skill-test run token cannot use this API action.");
  }

  async function assignmentTargetIsInCompany(resource: AuthorizationResource) {
    if (resource.type !== "issue") return true;
    if (resource.assigneeAgentId) {
      const target = await loadAgent(resource.assigneeAgentId);
      return Boolean(
        target &&
        target.companyId === resource.companyId &&
        isSimpleAssignableAgentStatus(target.status),
      );
    }
    if (resource.assigneeUserId) {
      return Boolean(await getActiveMembership(resource.companyId, "user", resource.assigneeUserId));
    }
    return true;
  }

  async function assignmentPolicyEffect(resource: AuthorizationResource): Promise<AssignmentPolicyEffect> {
    if (resource.type !== "issue") return { kind: "none" };

    const checks: Array<Promise<AssignmentPolicyEffect>> = [];
    if (resource.assigneeAgentId) {
      checks.push(
        loadAgent(resource.assigneeAgentId).then((agent) =>
          evaluateAuthorizationPolicyForAssignment(
            readPolicyObject(agent?.permissions, "authorizationPolicy"),
            "Target agent",
          ),
        ),
      );
    }
    if (resource.projectId) {
      checks.push(
        loadProjectAuthorizationPolicy(resource.companyId, resource.projectId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Target project"),
        ),
      );
    }
    if (resource.issueId) {
      checks.push(
        loadIssueAuthorizationPolicy(resource.companyId, resource.issueId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Target issue"),
        ),
      );
    }
    if (resource.parentIssueId && resource.parentIssueId !== resource.issueId) {
      checks.push(
        loadIssueAuthorizationPolicy(resource.companyId, resource.parentIssueId).then((policy) =>
          evaluateAuthorizationPolicyForAssignment(policy, "Parent issue"),
        ),
      );
    }
    if (checks.length === 0) return { kind: "none" };

    const effects = await Promise.all(checks);
    return (
      effects.find((effect) => effect.kind === "unknown") ??
      effects.find((effect) => effect.kind === "requires_approval") ??
      effects.find((effect) => effect.kind === "restricted") ??
      { kind: "none" }
    );
  }

  async function isManagerOf(companyId: string, managerAgentId: string, assigneeAgentId: string) {
    return isAgentInSubtree(db, companyId, managerAgentId, assigneeAgentId);
  }

  function commentAuthorCanGrantIssueMention(input: {
    mentionedAgentId: string;
    issueAssigneeAgentId: string | null;
    authorAgentId: string | null;
    authorUserId: string | null;
    activeAuthorUserIds: Set<string>;
  }) {
    if (input.authorAgentId) {
      if (input.authorAgentId === input.mentionedAgentId) return false;
      return input.issueAssigneeAgentId === input.authorAgentId;
    }
    if (input.authorUserId) {
      return input.activeAuthorUserIds.has(input.authorUserId);
    }
    return false;
  }

  async function agentHasMentionGrantOnIssue(input: {
    action: AuthorizationAction;
    companyId: string;
    issueId: string;
    issueAssigneeAgentId: string | null;
    actorAgentId: string;
  }) {
    const rows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        isNull(issueComments.deletedAt),
        sql`${issueComments.body} LIKE ${"%agent://" + input.actorAgentId + "%"}`,
      ));

    const mentionRows = rows.filter((row) => extractAgentMentionIds(row.body).includes(input.actorAgentId));
    const authorUserIds = [...new Set(mentionRows.flatMap((row) => row.authorUserId ? [row.authorUserId] : []))];
    const activeAuthorUserIds = new Set(
      authorUserIds.length === 0
        ? []
        : await db
          .select({ principalId: companyMemberships.principalId })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, input.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, authorUserIds),
          ))
          .then((memberships) => memberships.map((membership) => membership.principalId)),
    );

    for (const row of mentionRows) {
      const authorCanGrant = commentAuthorCanGrantIssueMention({
        mentionedAgentId: input.actorAgentId,
        issueAssigneeAgentId: input.issueAssigneeAgentId,
        authorAgentId: row.authorAgentId,
        authorUserId: row.authorUserId,
        activeAuthorUserIds,
      });
      if (authorCanGrant) {
        logger.info({
          actorAgentId: input.actorAgentId,
          issueId: input.issueId,
          companyId: input.companyId,
          commentId: row.id,
          grantedAction: input.action,
          grant: "issue_mention_comment",
        }, "authorized issue mention-scoped comment grant");
        return true;
      }
    }
    return false;
  }

  function allowIssueMentionGrant(action: AuthorizationAction): AuthorizationDecision {
    return allow({
      action,
      reason: "allow_issue_mention_grant",
      explanation: "Allowed by a mention-scoped issue comment grant.",
    });
  }

  async function decideBase(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }): Promise<AuthorizationDecision> {
    const permissionKey = permissionForAction(input.action);
    const companyId = companyIdForResource(input.resource);

    /**
     * Shared default-open decision for issue write-influence channels.
     *
     * Keep visibility structurally upstream of every standard-trust write so
     * future visibility scoping can be implemented in issue:read without
     * recreating per-action scope checks. The responsible-user ceiling remains
     * in decide(), after this base decision.
     */
    async function decideVisibleIssueWrite(): Promise<AuthorizationDecision> {
      let visibilityResource: AuthorizationResource = input.resource;

      // New-child assignment decisions identify the issue being influenced by
      // parentIssueId. Resolve that parent into the same resource shape used by
      // issue:read so child-create and assign share the visibility hook.
      if (
        input.resource.type === "issue" &&
        !input.resource.issueId &&
        input.resource.parentIssueId
      ) {
        const parent = await loadIssue(input.resource.parentIssueId);
        if (!parent || parent.companyId !== companyId) {
          return deny({
            action: input.action,
            reason: "deny_company_boundary",
            explanation: "The issue write target is not visible in this company.",
          });
        }
        visibilityResource = {
          type: "issue",
          companyId: parent.companyId,
          issueId: parent.id,
          projectId: parent.projectId,
          parentIssueId: parent.parentId,
          assigneeAgentId: parent.assigneeAgentId,
          assigneeUserId: parent.assigneeUserId,
          originKind: parent.originKind,
          originId: parent.originId,
          status: parent.status,
        };
      }

      const visibilityDecision = visibilityResource.type === "issue" && visibilityResource.issueId
        ? await decideBase({
            actor: input.actor,
            action: "issue:read",
            resource: visibilityResource,
            scope: input.scope,
          })
        : await decideBase({
            actor: input.actor,
            action: "company_scope:read",
            resource: { type: "company", companyId },
            scope: input.scope,
          });

      if (!visibilityDecision.allowed) {
        return {
          ...visibilityDecision,
          action: input.action,
          explanation: `Issue write denied because the target is not visible: ${visibilityDecision.explanation}`,
        };
      }

      return allow({
        action: input.action,
        reason: "allow_visible_issue_write",
        explanation: "Allowed by the shared default-open visible-issue write rule.",
      });
    }

    async function decideWithTaskAssignmentGrants(
      principalType: PrincipalType,
      principalId: string,
    ): Promise<AuthorizationDecision> {
      const broadDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "tasks:assign",
        scope: input.scope,
      });
      if (broadDecision.allowed || broadDecision.reason === "deny_missing_membership") return broadDecision;
      const scopedDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "tasks:assign_scope",
        scope: input.scope,
      });
      if (scopedDecision.allowed || broadDecision.reason === "deny_missing_grant") return scopedDecision;
      return broadDecision;
    }

    async function decideWithAgentConfigReadGrant(
      principalType: PrincipalType,
      principalId: string,
    ): Promise<AuthorizationDecision> {
      const configureDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:configure",
        scope: input.scope,
      });
      if (configureDecision.allowed || configureDecision.reason === "deny_missing_membership") {
        return configureDecision;
      }

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: "agents:suggest-changes",
        scope: input.scope,
      });
      if (suggestDecision.allowed || suggestDecision.reason === "deny_missing_grant") {
        return suggestDecision;
      }
      return configureDecision;
    }

    async function decideWithProtectedChangeGrants(
      principalType: PrincipalType,
      principalId: string,
      keys: { direct: PermissionKey; suggest: PermissionKey },
    ): Promise<AuthorizationDecision> {
      const directDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.direct,
        scope: input.scope,
      });
      if (directDecision.allowed) {
        return allow({
          action: input.action,
          reason: "allow_direct_change",
          explanation: `Allowed by direct change permission ${keys.direct}.`,
          grant: directDecision.grant,
        });
      }
      if (directDecision.reason === "deny_missing_membership") return directDecision;

      const suggestDecision = await decidePrincipalGrant({
        companyId,
        principalType,
        principalId,
        action: input.action,
        permissionKey: keys.suggest,
        scope: input.scope,
      });
      if (suggestDecision.allowed) {
        if (scopeBoolean(input.scope, "consentedChange")) {
          return allow({
            action: input.action,
            reason: "allow_consented_change",
            explanation: `Allowed by suggest permission ${keys.suggest} after accepted change consent.`,
            grant: suggestDecision.grant,
          });
        }
        return deny({
          action: input.action,
          reason: "deny_missing_consent",
          explanation: `Permission ${keys.suggest} requires accepted change consent before applying this mutation.`,
          grant: suggestDecision.grant,
        });
      }
      if (suggestDecision.reason === "deny_missing_membership") return suggestDecision;
      if (directDecision.reason === "deny_scope") return directDecision;
      if (suggestDecision.reason === "deny_scope") return suggestDecision;

      return deny({
        action: input.action,
        reason: "deny_no_grant",
        explanation: `Missing permission: ${keys.direct} or ${keys.suggest}.`,
      });
    }

    async function denyForAssignmentPolicyIfNeeded(
      policyEffect: AssignmentPolicyEffect,
    ): Promise<AuthorizationDecision | null> {
      if (policyEffect.kind === "none" || policyEffect.kind === "restricted") return null;
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation: policyEffect.explanation,
      });
    }

    function denyRestrictedAssignmentPolicy(policyEffect: AssignmentPolicyEffect): AuthorizationDecision {
      return deny({
        action: input.action,
        reason: "deny_policy_restricted",
        explanation:
          policyEffect.kind === "restricted"
            ? policyEffect.explanation
            : "Restrictive authorization policy blocks simple company-wide task assignment.",
      });
    }

    if (input.actor.type === "none") {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Authentication required.",
      });
    }

    if (input.actor.type === "board") {
      let taskAssignmentPolicyEffect: AssignmentPolicyEffect | null = null;
      if (input.actor.source === "local_implicit") {
        return allow({
          action: input.action,
          reason: "allow_local_board",
          explanation: "Allowed because the actor is the local implicit board.",
        });
      }
      // A cloud_tenant actor's computed `isInstanceAdmin` flag is trusted: it
      // can only be set by the attested trusted-header resolver (stack owner +
      // `enableOwnerInstanceAdmin`). The `instance_user_roles` DB lookup stays
      // excluded for cloud_tenant actors, so a stale or hand-inserted
      // instance_admin row left behind by deployments that ran the
      // pre-hardening cloud_tenant path still elevates nothing.
      if (
        !input.actor.ignoreInstanceAdmin &&
        (input.actor.isInstanceAdmin ||
          (input.actor.source !== "cloud_tenant" && await isInstanceAdmin(input.actor.userId)))
      ) {
        return allow({
          action: input.action,
          reason: "allow_instance_admin",
          explanation: "Allowed because the actor is an instance admin.",
        });
      }
      // What instance-admin elevation used to give cloud tenant users is
      // replaced by company-scoped visibility: an active membership in the
      // resource company grants the same read surface a same-company agent
      // gets, and non-viewer members may mutate issues inside their company.
      // Cross-company access stays denied.
      if (input.actor.source === "cloud_tenant" && input.actor.userId) {
        const membership = await getActiveMembership(companyId, "user", input.actor.userId);
        if (membership) {
          if (
            input.action === "agent:read" ||
            input.action === "company_scope:read" ||
            input.action === "decision_queue:read" ||
            input.action === "issue:read" ||
            input.action === "project:read"
          ) {
            return allow({
              action: input.action,
              reason: "allow_company_member",
              explanation: "Allowed by active cloud tenant company membership.",
            });
          }
          if (
            (
              input.action === "issue:comment" ||
              input.action === "issue:mutate" ||
              input.action === "decision_queue:manage" ||
              input.action === "decision_triage:manage"
            ) &&
            membership.membershipRole !== "viewer"
          ) {
            return allow({
              action: input.action,
              reason: "allow_company_member",
              explanation: "Allowed by active cloud tenant company membership.",
            });
          }
        }
      }
      if (!input.actor.userId) {
        return deny({
          action: input.action,
          reason: "deny_unauthenticated",
          explanation: "Board user id is required.",
        });
      }
      if (input.action === "tasks:assign") {
        if (!(await assignmentTargetIsInCompany(input.resource))) {
          return deny({
            action: input.action,
            reason: "deny_company_boundary",
            explanation: "Task assignment target agent is not active in the target company.",
          });
        }
        const policyEffect = await assignmentPolicyEffect(input.resource);
        taskAssignmentPolicyEffect = policyEffect;
        const policyDeny = await denyForAssignmentPolicyIfNeeded(policyEffect);
        if (policyDeny) return policyDeny;
        const membership = await getActiveMembership(companyId, "user", input.actor.userId);
        if (policyEffect.kind === "none" && membership && membership.membershipRole !== "viewer") {
          return allow({
            action: input.action,
            reason: "allow_simple_company_member",
            explanation: "Allowed by simple mode company-wide task assignment default.",
          });
        }
      }
      if (input.action === "agent_config:read") {
        return decideWithAgentConfigReadGrant("user", input.actor.userId);
      }
      if (input.action === "agent_config:update") {
        // Part (a): 資訊部 (IT) users may edit any agent EXCEPT the protected admin
        // tier (founder / 惠君 / Jay). This only WIDENS access — a non-資訊部 actor,
        // or a protected target, falls through to the standard grant logic below.
        // teams: [] for now — option-3 team grants activate once a team model exists.
        if (input.resource.type === "agent" && input.resource.agentId) {
          const [itActorEmail, targetOwnerEmail] = await Promise.all([
            loadUserEmail(input.actor.userId),
            loadAgentOwnerEmail(input.resource.agentId),
          ]);
          if (
            itEditorMayEditAgent(
              { email: itActorEmail, teams: [] },
              { agentId: input.resource.agentId, ownerEmail: targetOwnerEmail },
            )
          ) {
            return allow({
              action: input.action,
              reason: "allow_it_department_editor",
              explanation: "Allowed: actor is a 資訊部 editor and the target is not a protected admin-tier agent.",
            });
          }
        }
        return decideWithProtectedChangeGrants("user", input.actor.userId, {
          direct: "agents:configure",
          suggest: "agents:suggest-changes",
        });
      }
      if (input.action === "skill_config:update") {
        return decideWithProtectedChangeGrants("user", input.actor.userId, {
          direct: "skills:create",
          suggest: "skills:suggest-changes",
        });
      }
      if (!permissionKey) {
        if (isRestrictableAction(input.action)) {
          const membership = await getActiveMembership(companyId, "user", input.actor.userId);
          // 四季 restriction (flag-gated): non-privileged members are scoped to
          // their visible agents / own issues instead of company-wide visibility.
          //
          // The decision is TOTAL — there is no third outcome that falls
          // through to the company-wide allow below. That fall-through was the
          // bug: it made "company-wide" the default for anything nobody had
          // thought about yet.
          if (
            restrictAgentVisibilityEnabled() &&
            membership &&
            !isPrivilegedCompanyRole(membership.membershipRole)
          ) {
            const restricted = await restrictedMemberCanRead(
              input.action,
              companyId,
              input.actor.userId,
              input.resource,
            );
            if (restricted) {
              return allow({
                action: input.action,
                reason: "allow_simple_company_member",
                explanation: "Allowed: resource is within the restricted member's visible scope.",
              });
            }
            return deny({
              action: input.action,
              reason: "deny_scope",
              explanation: "Restricted member: resource is outside the visible agent/issue scope.",
            });
          }
          // Phase 5: project privacy gate (flag-gated).
          // Applied BEFORE the standard membership allow so private projects
          // are blocked even for active members who aren't explicit members.
          if (
            (input.action === "project:read" || input.action === "issue:read") &&
            projectVisibilityEnabled()
          ) {
            const projectId =
              input.resource.type === "project"
                ? input.resource.projectId ?? null
                : input.resource.type === "issue"
                  ? input.resource.projectId ?? null
                  : null;
            const privacyDecision = await decidePrivateProjectRead(
              input.action,
              companyId,
              projectId,
              input.actor,
              membership?.membershipRole,
            );
            if (privacyDecision === false) {
              return deny({
                action: input.action,
                reason: "deny_scope",
                explanation: "Project is private: actor is not a project member.",
              });
            }
            if (privacyDecision === true) {
              return allow({
                action: input.action,
                reason: "allow_explicit_grant",
                explanation: "Allowed: actor is an explicit project member or privileged.",
              });
            }
            // null = not private → fall through
          }
          // Mirroring the tasks:assign carve-out above, viewers keep the
          // read-only visibility actions but not the privileged ones.
          const requiresNonViewer =
            input.action === "runtime:manage" ||
            input.action === "secrets:read" ||
            input.action === "decision_queue:manage" ||
            input.action === "decision_triage:manage";
          if (membership && (!requiresNonViewer || membership.membershipRole !== "viewer")) {
            return allow({
              action: input.action,
              reason: "allow_simple_company_member",
              explanation: "Allowed by standard same-company board membership visibility.",
            });
          }
          if (membership) {
            return deny({
              action: input.action,
              reason: "deny_missing_grant",
              explanation: `Viewer membership does not grant ${input.action}.`,
            });
          }
          return deny({
            action: input.action,
            reason: "deny_missing_membership",
            explanation: `user principal ${input.actor.userId} is not an active member of company ${companyId}.`,
          });
        }
        return deny({
          action: input.action,
          reason: "deny_unsupported_action",
          explanation: `No board permission mapping exists for ${input.action}.`,
        });
      }
      if (input.action === "tasks:assign") {
        const grantDecision = await decideWithTaskAssignmentGrants("user", input.actor.userId);
        if (grantDecision.allowed) return grantDecision;
        const policyEffect = taskAssignmentPolicyEffect ?? await assignmentPolicyEffect(input.resource);
        if (policyEffect.kind === "restricted") return denyRestrictedAssignmentPolicy(policyEffect);
        return grantDecision;
      }
      return decidePrincipalGrant({
        companyId,
        principalType: "user",
        principalId: input.actor.userId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
    }

    const actorAgentId = input.actor.agentId ?? null;
    if (!actorAgentId) {
      return deny({
        action: input.action,
        reason: "deny_unauthenticated",
        explanation: "Agent authentication required.",
      });
    }
    if (input.actor.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Agent key cannot access another company.",
      });
    }

    const actorAgent = await loadAgent(actorAgentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      return deny({
        action: input.action,
        reason: "deny_company_boundary",
        explanation: "Actor agent was not found in the target company.",
      });
    }

    if (input.actor.keyScope?.kind === "skill_test") {
      const skillTestDecision = decideSkillTestAccess({
        action: input.action,
        resource: input.resource,
        scope: input.actor.keyScope,
      });
      if (skillTestDecision) return skillTestDecision;
    }

    if (input.actor.keyScope?.kind === "task_bridge") {
      const keyId = input.actor.keyId ?? null;
      if (!keyId) {
        return deny({
          action: input.action,
          reason: "deny_scope",
          explanation: "Task bridge key context is missing.",
        });
      }
      const taskBridgeDecision = await decideTaskBridgeAccess({
        actorAgentId,
        action: input.action,
        resource: input.resource,
        scope: input.actor.keyScope,
        keyId,
      });
      if (taskBridgeDecision) return taskBridgeDecision;
    }

    const trustResolution = await resolveActorTrust({
      actorAgent,
      actor: input.actor,
      companyId,
      resource: input.resource,
    });
    const directParentReportTarget =
      input.action === "issue:comment" &&
      await isDirectParentReportTarget({
        actor: input.actor,
        actorAgentId,
        companyId,
        resource: input.resource,
      });
    const lowTrustDecision = await decideLowTrustAccess({
      actorAgentId,
      action: input.action,
      resource: input.resource,
      resolution: trustResolution,
      directParentReportTarget,
    });
    if (lowTrustDecision) {
      if (!lowTrustDecision.allowed) return lowTrustDecision;
      if (
        input.action === "agent:read" ||
        input.action === "agent:wake" ||
        input.action === "company_scope:read" ||
        input.action === "decision_queue:read" ||
        input.action === "issue:comment" ||
        input.action === "issue:read" ||
        input.action === "project:read" ||
        input.action === "runtime:manage" ||
        input.action === "secrets:read"
      ) {
        return lowTrustDecision;
      }
    }

    const visibleIssueWriteDecision =
      trustResolution.kind === "standard" &&
      (input.action === "issue:comment" || input.action === "issue:mutate")
        ? await decideVisibleIssueWrite()
        : null;
    if (visibleIssueWriteDecision && !visibleIssueWriteDecision.allowed) {
      return visibleIssueWriteDecision;
    }

    if (
      trustResolution.kind === "standard" &&
      input.action === "issue:comment" &&
      directParentReportTarget
    ) {
      return allow({
        action: input.action,
        reason: "allow_direct_parent_report",
        explanation: "Allowed because the target is the current run issue's direct parent under the standard trust preset.",
      });
    }


    if (input.action === "inbox:manage") {
      if (!isSimpleAssignableAgentStatus(actorAgent.status)) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: "Actor agent is not active in the target company.",
        });
      }
      const responsibleUserId = input.actor.onBehalfOfUserId?.trim() || null;
      const explicitTargetUserId = typeof input.scope?.userId === "string"
        ? input.scope.userId.trim() || null
        : null;
      const targetUserId = explicitTargetUserId ?? responsibleUserId;
      if (!targetUserId) {
        return deny({
          action: input.action,
          reason: "inbox_target_user_unresolved",
          explanation: "Inbox target user could not be resolved from the request or responsible-user context.",
        });
      }

      const targetSnapshot = await getResponsibleUserSnapshot({
        actor: input.actor,
        companyId,
        userId: targetUserId,
      });
      if (!targetSnapshot.userExists || !targetSnapshot.activeMembership) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: `Inbox target user ${targetUserId} is not an active member of company ${companyId}.`,
        });
      }

      if (targetUserId !== responsibleUserId) {
        // Cross-user grants are board-admin overrides; user policies only govern responsible-user default access.
        const grant = await findGrant(companyId, "agent", actorAgentId, "inbox:manage");
        if (!grant) {
          return deny({
            action: input.action,
            reason: "deny_missing_grant",
            explanation: "Missing permission: inbox:manage.",
          });
        }
        if (!(await scopeAllows(db, companyId, grant.scope, { userId: targetUserId }))) {
          return deny({
            action: input.action,
            reason: "deny_scope",
            explanation: "Permission inbox:manage does not cover the requested user.",
            grant: {
              principalType: "agent",
              principalId: actorAgentId,
              permissionKey: "inbox:manage",
              scope: grant.scope ?? null,
            },
          });
        }
        return allow({
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by explicit grant inbox:manage.",
          inboxPolicyMode: "grant_override",
          grant: {
            principalType: "agent",
            principalId: actorAgentId,
            permissionKey: "inbox:manage",
            scope: grant.scope ?? null,
          },
        });
      }

      const policy = await db
        .select({
          mode: userInboxAgentPolicies.mode,
          allowedAgentIds: userInboxAgentPolicies.allowedAgentIds,
        })
        .from(userInboxAgentPolicies)
        .where(
          and(
            eq(userInboxAgentPolicies.companyId, companyId),
            eq(userInboxAgentPolicies.userId, targetUserId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (policy?.mode === "disabled") {
        return deny({
          action: input.action,
          reason: "inbox_management_disabled",
          explanation: `Inbox management is disabled for user ${targetUserId}.`,
        });
      }
      if (policy?.mode === "allowlist" && !policy.allowedAgentIds.includes(actorAgentId)) {
        return deny({
          action: input.action,
          reason: "inbox_agent_not_allowed",
          explanation: `Agent ${actorAgentId} is not allowed to manage user ${targetUserId}'s inbox.`,
        });
      }

      return allow({
        action: input.action,
        reason: "allow_self",
        inboxPolicyMode: policy?.mode ?? "open",
        explanation: policy?.mode === "allowlist"
          ? "Allowed by the responsible user's inbox agent allowlist."
          : "Allowed by the responsible user's default-open inbox policy.",
      });
    }

    // Phase 2: agent task/project scoping (flag-gated, mirrors the board gate).
    // An agent's access to a scoped (team/private) project — and to issues in it —
    // follows the same rules as humans: explicit project membership, team match, or
    // (for issues) being the assignee / mention-granted. Inert unless the flag is on.
    if (
      (input.action === "issue:read" || input.action === "project:read") &&
      projectPrivacyEnabled()
    ) {
      const resourceIssue = input.resource.type === "issue" ? input.resource : null;
      const isAssignee = !!resourceIssue?.assigneeAgentId && resourceIssue.assigneeAgentId === actorAgentId;
      if (!isAssignee) {
        const projectId =
          input.resource.type === "project"
            ? input.resource.projectId ?? null
            : resourceIssue
              ? resourceIssue.projectId ?? null
              : null;
        const privacyDecision = await decidePrivateProjectRead(
          input.action,
          companyId,
          projectId,
          input.actor,
          undefined,
        );
        if (privacyDecision === false) {
          if (
            input.action === "issue:read" &&
            resourceIssue?.issueId &&
            (await agentHasMentionGrantOnIssue({
              action: input.action,
              companyId,
              issueId: resourceIssue.issueId,
              issueAssigneeAgentId: resourceIssue.assigneeAgentId ?? null,
              actorAgentId,
            }))
          ) {
            return allowIssueMentionGrant(input.action);
          }
          return deny({
            action: input.action,
            reason: "deny_scope",
            explanation: "Project is scoped (team/private): agent is not in scope.",
          });
        }
        // true (explicit member / team match) or null (not scoped) → fall through.
      }
    }

    /**
     * The 四季 restriction, applied to AGENT actors.
     *
     * The same hole as the human one and wider, because agents are what
     * actually make the API calls: a member's personal assistant could read
     * every other person's tasks and every project in the company. Scoped by the
     * agent's MAPPED USER, which is the ownership rule the whole platform uses —
     * an agent reaches its user's world, never the acting user's and never the
     * company's.
     *
     * `secrets:read` is included, and safely, because the decision is now
     * per-secret. The run-time path (`resolveSecretValueForAgentAccess`) already
     * required a `company_secret_bindings` row for the agent before handing over
     * a value, so "bound to an agent this user can see" is a superset of what
     * that path already permits — an agent fetching its own token gets the same
     * answer it got before. What changes is everything else: it can no longer
     * reach a credential belonging to somebody else's corner of the company.
     *
     * `runtime:manage` is included now that the execution-workspace routes name
     * the workspace's PROJECT instead of the bare company. An agent may control
     * runtime in a project its user works in, and nowhere else.
     *
     * `company_scope:read` is also excluded, for a different reason again. The
     * human branch denies it outright to FORCE per-item filtering, and that
     * works because the list endpoints humans hit all filter per item. Agents
     * reach some of those endpoints by paths that have not been shown to filter,
     * so denying it could quietly empty an agent's view of its own work rather
     * than narrowing it. It belongs in this set once each consumer is checked.
     */
    const agentScopedVisibilityActions = [
      "agent:read",
      "issue:read",
      "project:read",
      "secrets:read",
      "runtime:manage",
      // Added once every consumer was audited (doc/audits/company-scope-read-audit.md).
      // Until then an agent skipped the human branch — which DENIES this to force
      // per-item filtering — and received the company-wide allow, so an unpaired
      // agent read every workspace and every approval in the company.
      //
      // Safe now because each of the 13 consumers was handled first:
      //   9 already narrowed per item and simply lose a shortcut;
      //   execution-workspaces and approvals now narrow their LISTS instead of
      //     gating on this, so a denial scopes them rather than emptying them;
      //   costs (7 aggregate endpoints) and company search legitimately refuse a
      //     non-privileged caller — members are already denied, and an agent has
      //     no more claim to company-wide spend or search than they do.
      //
      // Order mattered in one direction only: flipping this before those two lists
      // narrowed would have 403'd agents out of their own work.
      "company_scope:read",
    ] as const;
    if (
      restrictAgentVisibilityEnabled() &&
      (agentScopedVisibilityActions as readonly string[]).includes(input.action)
    ) {
      const scoped = await restrictedAgentActorCanRead(
        input.action as RestrictableAction,
        companyId,
        actorAgentId,
        input.resource,
      );
      if (scoped !== null) {
        return scoped
          ? allow({
            action: input.action,
            reason: "allow_company_agent",
            explanation: "Allowed: resource is within the mapped user's visible scope.",
          })
          : deny({
            action: input.action,
            reason: "deny_scope",
            explanation: "Restricted member's agent: resource is outside the mapped user's visible scope.",
          });
      }
    }

    if (
      input.action === "agent:read" ||
      input.action === "company_scope:read" ||
      input.action === "decision_queue:read" ||
      input.action === "issue:read" ||
      input.action === "project:read" ||
      input.action === "runtime:manage" ||
      input.action === "secrets:read"
    ) {
      return allow({
        action: input.action,
        reason: "allow_company_agent",
        explanation: "Allowed by standard same-company agent visibility.",
      });
    }

    if (input.action === "decision_queue:manage" || input.action === "decision_triage:manage") {
      if (!isSimpleAssignableAgentStatus(actorAgent.status)) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: "Actor agent is not active in the target company.",
        });
      }
      return allow({
        action: input.action,
        reason: "allow_company_agent",
        explanation: "Allowed for an active standard-scope company agent.",
      });
    }

    if (input.action === "agent:wake" && input.resource.type === "agent" && input.resource.agentId === actorAgentId) {
      return allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor is waking itself.",
      });
    }

    if (input.action === "tasks:assign") {
      if (!isSimpleAssignableAgentStatus(actorAgent.status)) {
        return deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: "Actor agent is not active for simple mode task assignment.",
        });
      }
      if (!(await assignmentTargetIsInCompany(input.resource))) {
        return deny({
          action: input.action,
          reason: "deny_company_boundary",
          explanation: "Task assignment target agent is not active in the target company.",
        });
      }
      const policyEffect = await assignmentPolicyEffect(input.resource);
      const policyDeny = await denyForAssignmentPolicyIfNeeded(policyEffect);
      if (policyDeny) return policyDeny;
      if (policyEffect.kind === "restricted") {
        const grantDecision = await decideWithTaskAssignmentGrants("agent", actorAgentId);
        if (grantDecision.allowed) return grantDecision;
        return denyRestrictedAssignmentPolicy(policyEffect);
      }
      if (trustResolution.kind === "standard") return decideVisibleIssueWrite();
      return allow({
        action: input.action,
        reason: "allow_simple_company_member",
        explanation: "Allowed by the existing bounded task assignment rule.",
      });
    }

    if (input.action === "issue:comment" || input.action === "issue:mutate") {
      const resource = input.resource.type === "issue" ? input.resource : null;
      if (resource?.assigneeAgentId === actorAgentId) {
        return allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed because the actor owns the assigned issue.",
        });
      }
      if (!resource?.assigneeAgentId) {
        // Phase 2: an unassigned issue in a scoped (team/private) project may only be
        // acted on by agents in that project's scope. Inert unless the flag is on.
        if (projectPrivacyEnabled()) {
          const scoped = await decidePrivateProjectRead(
            "issue:read",
            companyId,
            resource?.projectId ?? null,
            input.actor,
            undefined,
          );
          if (scoped === false) {
            return deny({
              action: input.action,
              reason: "deny_scope",
              explanation: "Issue's project is scoped (team/private): agent is not in scope.",
            });
          }
        }
        return allow({
          action: input.action,
          reason: "allow_company_agent",
          explanation: "Allowed because the issue has no agent assignee.",
        });
      }
      if (
        input.action === "issue:comment" &&
        resource?.issueId &&
        await agentHasMentionGrantOnIssue({
          action: input.action,
          companyId,
          issueId: resource.issueId,
          issueAssigneeAgentId: resource.assigneeAgentId ?? null,
          actorAgentId,
        })
      ) {
        return allowIssueMentionGrant(input.action);
      }
      if (visibleIssueWriteDecision) return visibleIssueWriteDecision;
    }
    if (
      input.action === "agent_config:update" &&
      input.resource.type === "agent" &&
      input.resource.agentId === actorAgentId &&
      !scopeBoolean(input.scope, "requiresChangeGrant")
    ) {
      return allow({
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor is updating its own agent configuration.",
      });
    }

    if (input.action === "agent_config:read") {
      if (input.resource.type === "agent" && input.resource.agentId === actorAgentId) {
        return allow({
          action: input.action,
          reason: "allow_self",
          explanation: "Allowed because the actor is reading its own agent configuration.",
        });
      }
      return decideWithAgentConfigReadGrant("agent", actorAgentId);
    }

    if (input.action === "agent_config:update") {
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "agents:configure",
        suggest: "agents:suggest-changes",
      });
    }

    if (input.action === "skill_config:update") {
      return decideWithProtectedChangeGrants("agent", actorAgentId, {
        direct: "skills:create",
        suggest: "skills:suggest-changes",
      });
    }

    if (permissionKey) {
      const grantDecision = await decidePrincipalGrant({
        companyId,
        principalType: "agent",
        principalId: actorAgentId,
        action: input.action,
        permissionKey,
        scope: input.scope,
      });
      if (grantDecision.allowed) return grantDecision;
    }

    if (
      (input.action === "agents:create" ||
        input.action === "tasks:manage_active_checkouts") &&
      canCreateAgentsLegacy(actorAgent)
    ) {
      return allow({
        action: input.action,
        reason: "allow_legacy_agent_creator",
        explanation: "Allowed by legacy agent creator authority.",
      });
    }

    if (
      input.action === "tasks:manage_active_checkouts" &&
      input.resource.type === "issue" &&
      input.resource.assigneeAgentId &&
      await isManagerOf(companyId, actorAgentId, input.resource.assigneeAgentId)
    ) {
      return allow({
        action: input.action,
        reason: "allow_manager_chain",
        explanation: "Allowed because the actor manages the issue assignee in the reporting chain.",
      });
    }

    return deny({
      action: input.action,
      reason: "deny_missing_grant",
      explanation: permissionKey
        ? `Missing permission: ${permissionKey}.`
        : `No agent permission mapping exists for ${input.action}.`,
    });
  }

  async function applyResponsibleUserIntersection(
    input: {
      actor: AuthorizationActor;
      action: AuthorizationAction;
      resource: AuthorizationResource;
      scope?: Record<string, unknown> | null;
    },
    agentDecision: AuthorizationDecision,
  ): Promise<AuthorizationDecision> {
    const responsibleUserId = input.actor.onBehalfOfUserId?.trim();
    if (
      input.actor.type !== "agent" ||
      input.action === "inbox:manage" ||
      !responsibleUserId ||
      !agentDecision.allowed
    ) {
      return agentDecision;
    }

    const companyId = companyIdForResource(input.resource);
    const snapshot = await getResponsibleUserSnapshot({
      actor: input.actor,
      companyId,
      userId: responsibleUserId,
    });
    const denyCode: AuthorizationDecision["code"] =
      snapshot.userExists && snapshot.activeMembership
        ? "RESPONSIBLE_USER_UNAUTHORIZED"
        : "RESPONSIBLE_USER_UNAVAILABLE";

    if (
      activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(
        input.action,
        snapshot.activeMembership,
        agentDecision,
        input.actor.agentId,
      )
    ) {
      // Skill mutations are governed by the agent's explicit skill-change
      // grant. The responsible-user intersection still requires an active
      // non-viewer user, but does not require duplicating that grant on the
      // responsible user's board account for standard heartbeat JWTs.
      return agentDecision;
    }

    const userDecision = snapshot.userExists && snapshot.activeMembership
      ? await decideBase({
          ...input,
          actor: {
            type: "board",
            userId: responsibleUserId,
            companyIds: [companyId],
            memberships: [snapshot.activeMembership],
            isInstanceAdmin: false,
            ignoreInstanceAdmin: true,
            source: "session",
          },
        })
      : deny({
          action: input.action,
          reason: "deny_missing_membership",
          explanation: `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`,
        });

    if (
      !userDecision.allowed &&
      userDecision.reason === "deny_unsupported_action" &&
      activeResponsibleUserCanAuthorizeIssueAction(input.action, snapshot.activeMembership)
    ) {
      return agentDecision;
    }

    if (userDecision.allowed) return agentDecision;

    const denied = deny({
      action: input.action,
      reason: userDecision.reason,
      code: denyCode,
      explanation:
        denyCode === "RESPONSIBLE_USER_UNAVAILABLE"
          ? `Responsible user ${responsibleUserId} is unavailable for company ${companyId}.`
          : `Responsible user ${responsibleUserId} is not authorized for ${input.action}: ${userDecision.explanation}`,
      grant: userDecision.grant,
    });

    logger.warn({
      authzMode: responsibleUserAuthzShadowMode() ? "shadow" : "enforce",
      code: denied.code,
      reason: userDecision.reason,
      action: input.action,
      resourceType: input.resource.type,
      companyId,
      actorAgentId: input.actor.agentId ?? null,
      responsibleUserId,
    }, "responsible-user authorization intersection denied");

    return responsibleUserAuthzShadowMode() ? agentDecision : denied;
  }

  async function decide(input: {
    actor: AuthorizationActor;
    action: AuthorizationAction;
    resource: AuthorizationResource;
    scope?: Record<string, unknown> | null;
  }): Promise<AuthorizationDecision> {
    const agentDecision = await decideBase(input);
    return applyResponsibleUserIntersection(input, agentDecision);
  }

  /**
   * Can this actor see a routine, given its explicit sharing scope?
   *
   * Returns true=allow, false=deny, null="scope says nothing" — the caller then
   * falls back to the derived agent rule (assigned to an agent you oversee, or you
   * created it), which acts as the FLOOR. Keeping the floor in the caller means a
   * tightened scope can never hide a report's automation from their manager.
   *
   * Mirrors the project-visibility shape: `company` is open, `team` matches the
   * actor's team labels against the routine's sharingTeams, `private` requires an
   * explicit routine_access_members grant.
   */
  async function canActorSeeRoutineByScope(input: {
    companyId: string;
    actor: AuthorizationActor;
    routine: {
      id: string;
      visibility?: string | null;
      sharingTeams?: string[] | null;
      createdByUserId?: string | null;
    };
  }): Promise<boolean | null> {
    const { companyId, actor, routine } = input;
    const visibility = routine.visibility ?? "private";
    if (visibility === "company") return true;
    if (actor.type === "board" && actor.userId && routine.createdByUserId === actor.userId) return true;

    if (visibility === "team") {
      const shared = (routine.sharingTeams ?? []).map((t) => t.trim()).filter(Boolean);
      if (shared.length > 0) {
        const mine = await resolveActorTeams(companyId, actor);
        if (shared.some((team) => mine.has(team))) return true;
      }
    }

    if (actor.type === "board" && actor.userId) {
      const granted = await db
        .select({ id: routineAccessMembers.id })
        .from(routineAccessMembers)
        .where(and(
          eq(routineAccessMembers.routineId, routine.id),
          eq(routineAccessMembers.principalType, "user"),
          eq(routineAccessMembers.principalId, actor.userId),
        ))
        .then((rows) => rows.length > 0);
      if (granted) return true;
    }

    // Nothing in the explicit scope grants access; let the agent-visibility floor decide.
    return null;
  }

  return {
    decide,
    decidePrincipalGrant,
    canActorSeeRoutineByScope,
    /**
     * The agents a user can see: the ones they have joined, plus everything
     * reporting transitively to those. Exposed because list endpoints need the
     * SET to build a SQL filter — `decide` answers one resource at a time,
     * which cannot page or group correctly.
     */
    getVisibleAgentIdsForUser,
    /**
     * Is this issue part of this person's own world?
     *
     * The same question the restriction answers, asked for RELEVANCE rather than
     * for permission — and the distinction matters. An admin MAY see everything;
     * that does not mean everything belongs on their to-decide list. Sorting
     * through other people's pending approvals is how a queue stops being read.
     *
     * Deliberately the same code path as the restriction, so "what a restricted
     * member can see" and "what is relevant to me" can never drift into two
     * different notions of ownership.
     */
    issueIsRelevantToUser: (companyId: string, userId: string, issueId: string) =>
      restrictedMemberCanRead("issue:read", companyId, userId, {
        type: "issue",
        companyId,
        issueId,
      }),
    /** Whether the flag that narrows members to their own scope is on. */
    restrictAgentVisibilityEnabled,
  };
}
