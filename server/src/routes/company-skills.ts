import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, agentMemberships, authUsers, companySkills } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { leaderboardService } from "../services/leaderboard.js";
import { progressionFor } from "../services/office-progression.js";
import { agentProgressionService } from "../services/agent-progression.js";
import { notificationService } from "../services/notifications.js";
import {
  catalogSkillListQuerySchema,
  companySkillCommentCreateSchema,
  companySkillCommentUpdateSchema,
  companySkillCreateSchema,
  companySkillFolderCreateSchema,
  companySkillFolderUpdateSchema,
  companySkillFileDeleteSchema,
  companySkillFileUpdateSchema,
  companySkillForkSchema,
  companySkillImportSchema,
  companySkillInstallCatalogSchema,
  companySkillInstallUpdateSchema,
  companySkillListQuerySchema,
  companySkillProjectScanRequestSchema,
  companySkillResetSchema,
  companySkillTestInputCreateSchema,
  companySkillTestInputUpdateSchema,
  companySkillTestRunTemplateCreateSchema,
  companySkillTestRunTemplateUpdateSchema,
  companySkillTestRunCreateSchema,
  companySkillTestRunListQuerySchema,
  companySkillUpdateSchema,
  companySkillVersionCreateSchema,
} from "@paperclipai/shared";
import { trackSkillImported } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  companySkillService,
  heartbeatService,
  issueService,
  logActivity,
} from "../services/index.js";
import { isGitRepoSkillImportSource, parseSkillImportSourceInput } from "../services/company-skills.js";
import {
  getCatalogSkillOrThrow,
  listCatalogSkillsOrEmpty,
  readCatalogSkillFile,
} from "../services/skills-catalog.js";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { badRequest, forbidden, HttpError, unauthorized } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo, isPrivilegedMemberViewer } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";
import {
  companySkillPolicyService,
  normalizeSkillPolicySourceType,
  type SkillPolicyPrincipal,
} from "../services/company-skill-policy.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  normalizeSkillPolicySourceLocator,
  type SkillPolicyAction,
  type SkillPolicyDecision,
  type SkillPolicyEvaluationResource,
} from "@paperclipai/shared";

type SkillTelemetryInput = {
  key: string;
  slug: string;
  sourceType: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown> | null;
};

type SkillPolicyDenialResponse = {
  code: "skill_policy_denied";
  reason: SkillPolicyDecision["reason"];
  remediation?: string;
};

type SkillTestRunAssignmentAuthorizationScope = {
  issueId?: string | null;
  projectId?: string | null;
  parentIssueId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type SkillPolicyResourceInput =
  | SkillPolicyEvaluationResource
  | Promise<SkillPolicyEvaluationResource>
  | (() => SkillPolicyEvaluationResource | Promise<SkillPolicyEvaluationResource>);

export function companySkillRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const agents = agentService(db);
  const svc = companySkillService(db);
  const issues = issueService(db);
  const heartbeat = heartbeatService(db);
  const skillPolicies = companySkillPolicyService(db);

  // Add a skill to each agent's own desired-skills set (equip). Best-effort per
  // agent — one failure never blocks the others or the skill creation. Equipped
  // agents pick the skill up on their next heartbeat.
  async function equipSkillToAgents(
    companyId: string,
    skillKey: string,
    agentIds: string[],
    byAgentId: string | null,
  ) {
    for (const agentId of Array.from(new Set(agentIds))) {
      try {
        const ag = await agents.getById(agentId);
        if (!ag || ag.companyId !== companyId) continue;
        const config = (ag.adapterConfig ?? {}) as Record<string, unknown>;
        const pref = readPaperclipSkillSyncPreference(config);
        if (pref.desiredSkillEntries.some((entry) => entry.key === skillKey)) continue;
        const nextConfig = writePaperclipSkillSyncPreference(config, [
          ...pref.desiredSkillEntries,
          { key: skillKey, versionId: null },
        ]);
        await agents.update(agentId, { adapterConfig: nextConfig }, {
          recordRevision: { createdByAgentId: byAgentId, createdByUserId: null, source: "skill-auto-equip" },
        });
      } catch (err) {
        console.warn(`[skills] equip failed for agent ${agentId} / skill ${skillKey}:`, err);
      }
    }
  }

  function agentTeamNames(metadata: unknown): string[] {
    const md = metadata as Record<string, unknown> | null;
    if (!md) return [];
    const raw = md.teams;
    if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (typeof md.team === "string" && md.team.trim().length > 0) return [md.team.trim()];
    return [];
  }

  // The agent ids to equip for a skill, given its sharing scope:
  //   company/public_link → every agent in the company
  //   team                → agents whose team matches the skill's sharingTeams
  //   private             → the creator's own agents (or the authoring agent)
  async function resolveEquipTargets(
    companyId: string,
    scope: string,
    teams: string[],
    creatorUserId: string | null,
    creatorAgentId: string | null,
  ): Promise<string[]> {
    if (scope === "private") {
      if (creatorAgentId) return [creatorAgentId];
      if (!creatorUserId) return [];
      const rows = await db
        .select({ agentId: agentMemberships.agentId })
        .from(agentMemberships)
        .where(and(
          eq(agentMemberships.companyId, companyId),
          eq(agentMemberships.userId, creatorUserId),
          eq(agentMemberships.state, "joined"),
        ));
      return rows.map((r) => r.agentId);
    }
    const all = await agents.list(companyId);
    if (scope === "team") {
      const wanted = new Set(teams);
      if (wanted.size === 0) return [];
      return all.filter((a) => agentTeamNames(a.metadata).some((t) => wanted.has(t))).map((a) => a.id);
    }
    // company / public_link → everyone
    return all.map((a) => a.id);
  }

  function asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function deriveTrackedSkillRef(skill: SkillTelemetryInput): string | null {
    if (skill.sourceType === "skills_sh") {
      return skill.key;
    }
    if (skill.sourceType !== "github") {
      return null;
    }
    const hostname = asString(skill.metadata?.hostname);
    if (hostname !== "github.com") {
      return null;
    }
    return skill.key;
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  function optionalQueryBoolean(value: unknown) {
    const parsed = firstQueryString(value);
    if (parsed === undefined) return undefined;
    if (parsed === "true") return true;
    if (parsed === "false") return false;
    throw badRequest("Boolean query parameters must be true or false");
  }

  function queryStringArray(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
    return [];
  }

  function toSkillPolicyDenialResponse(
    decision: Pick<SkillPolicyDecision, "reason" | "remediation">,
  ): SkillPolicyDenialResponse {
    return {
      code: "skill_policy_denied",
      reason: decision.reason,
      ...(typeof decision.remediation === "string" ? { remediation: decision.remediation } : {}),
    };
  }

  function skillActor(req: Request) {
    if (req.actor.type === "agent") {
      return { type: "agent" as const, agentId: req.actor.agentId ?? null };
    }
    if (req.actor.type === "board") {
      return { type: "user" as const, userId: req.actor.userId ?? null };
    }
    return { type: "system" as const };
  }

  async function skillPolicyPrincipal(req: Request, companyId: string): Promise<SkillPolicyPrincipal> {
    if (req.actor.type === "agent" && req.actor.agentId) {
      return skillPolicies.resolveAgentPrincipal(companyId, req.actor.agentId);
    }
    if (req.actor.type === "board") {
      return { type: "board", id: req.actor.userId ?? "board", role: "board" };
    }
    throw unauthorized("Authentication required");
  }

  async function skillPolicyResource(input: {
    companyId: string;
    skillId?: string | null;
    skillKey?: unknown;
    sourceType?: string | null;
    sourceLocator?: unknown;
  }): Promise<SkillPolicyEvaluationResource> {
    const stored = input.skillId ? await svc.getById(input.companyId, input.skillId) : null;
    const sourceLocator = asString(input.sourceLocator) ?? stored?.sourceLocator ?? undefined;
    return {
      ...(input.skillId ? { skillId: input.skillId } : {}),
      ...(asString(input.skillKey) || stored?.key ? { skillKey: asString(input.skillKey) ?? stored?.key } : {}),
      ...((input.sourceType || stored?.sourceType) ? {
        sourceType: normalizeSkillPolicySourceType(input.sourceType ?? stored?.sourceType),
      } : {}),
      ...(sourceLocator ? { sourceLocator: normalizeSkillPolicySourceLocator(sourceLocator) } : {}),
    };
  }

  function skillImportPolicyResource(source: string): SkillPolicyEvaluationResource {
    const parsed = parseSkillImportSourceInput(source);
    const resolvedSource = parsed.resolvedSource;
    return {
      sourceType: normalizeSkillPolicySourceType(
        isGitRepoSkillImportSource(resolvedSource) ? "git" : /^https?:\/\//i.test(resolvedSource) ? "external_package" : "workspace",
      ),
      sourceLocator: normalizeSkillPolicySourceLocator(resolvedSource),
    };
  }

  async function assertCanMutateCompanySkills(
    req: Request,
    companyId: string,
    action: SkillPolicyAction,
    resource: SkillPolicyResourceInput = {},
  ) {
    if (req.actor.type === "none") {
      throw unauthorized("Authentication required");
    }
    if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company", { code: "skill_company_boundary_denied" });
    }
    assertCompanyAccess(req, companyId);
    const platformDecision = await access.decide({
      actor: req.actor,
      action: "skill_config:update",
      resource: { type: "company", companyId },
    });
    // Legacy missing-grant and suggest-change-consent denials are not platform
    // invariants for skills. The company skill policy is the governance layer;
    // authentication, company boundaries, and safety checks still fail closed.
    if (
      !platformDecision.allowed
      && !["deny_no_grant", "deny_missing_consent", "deny_missing_grant"].includes(platformDecision.reason)
    ) {
      throw forbidden(platformDecision.explanation, {
        code: platformDecision.reason === "deny_company_boundary"
          ? "skill_company_boundary_denied"
          : "skill_actor_restricted",
        reason: "platform_invariant",
      });
    }
    const resolvedResource = typeof resource === "function" ? await resource() : await resource;
    const policyDecision = await skillPolicies.evaluate({
      companyId,
      principal: await skillPolicyPrincipal(req, companyId),
      action,
      resource: resolvedResource,
    });
    if (!policyDecision.allowed) {
      throw forbidden("Skill action denied by company policy", toSkillPolicyDenialResponse(policyDecision));
    }
  }

  async function assertCanOrchestrateSkillTestHarness(
    req: Request,
    companyId: string,
    assignmentScope: SkillTestRunAssignmentAuthorizationScope = {},
  ) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: assignmentScope.issueId ?? null,
        projectId: assignmentScope.projectId ?? null,
        parentIssueId: assignmentScope.parentIssueId ?? null,
        assigneeAgentId: assignmentScope.assigneeAgentId ?? null,
        assigneeUserId: assignmentScope.assigneeUserId ?? null,
      },
      scope: assignmentScope,
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function loadSkillTestRunAssignmentScope(
    companyId: string,
    skillId: string,
    runId: string,
  ): Promise<SkillTestRunAssignmentAuthorizationScope> {
    const run = await svc.getTestRunDetail(companyId, skillId, runId);
    if (!run?.issueId) return {};
    const issue = await issues.getById(run.issueId);
    if (!issue || issue.companyId !== companyId) {
      return {
        issueId: run.issueId,
        assigneeAgentId: run.agentId ?? null,
      };
    }
    return {
      issueId: issue.id,
      projectId: issue.projectId ?? null,
      parentIssueId: issue.parentId ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? run.agentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
    };
  }

  // Only these two logins may file skills into the reserved numbered (00–10)
  // folders — the founder's org taxonomy. Others get them stripped server-side.
  const RESTRICTED_FOLDER_EMAILS = new Set(["tang@seasonart.org", "jay20020109@seasonart.org"]);
  async function actorAllowsRestrictedFolders(req: Request): Promise<boolean> {
    if (req.actor.type !== "board" || !req.actor.userId) return false;
    const row = await db
      .select({ email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, req.actor.userId))
      .then((rows) => rows[0] ?? null);
    return RESTRICTED_FOLDER_EMAILS.has((row?.email ?? "").trim().toLowerCase());
  }

  // Creating a NEW skill is open to everyone: any board member of the company,
  // and any agent whose canCreateSkills is not explicitly false. (Editing or
  // deleting EXISTING skills stays gated by assertCanMutateCompanySkills / grants.)
  async function assertCanCreateCompanySkill(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return; // membership implies create rights
    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const permissions = actorAgent.permissions as Record<string, unknown> | null | undefined;
    if (permissions && typeof permissions === "object" && permissions.canCreateSkills === false) {
      throw forbidden("This agent is not allowed to create skills (canCreateSkills is disabled).");
    }
  }

  router.get("/skills/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogSkillListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    res.json(listCatalogSkillsOrEmpty(query));
  });

  router.get("/skills/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "SKILL.md";
    res.json(await readCatalogSkillFile(catalogRef, relativePath));
  });

  router.get("/skills/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(getCatalogSkillOrThrow(catalogRef));
  });

  router.get("/companies/:companyId/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const viewer = req.actor.type === "board"
      ? { userId: req.actor.userId ?? null, isPrivileged: isPrivilegedMemberViewer(req, companyId, true) }
      : { isPrivileged: true }; // agents resolve skills via assignment; no privacy filter
    const result = await svc.list(companyId, companySkillListQuerySchema.parse({
      q: firstQueryString(req.query.q),
      sort: firstQueryString(req.query.sort),
      categories: [
        ...queryStringArray(req.query.category),
        ...queryStringArray(req.query.categories),
        ...queryStringArray(req.query["categories[]"]),
        ...queryStringArray(req.query.tag),
        ...queryStringArray(req.query.tags),
        ...queryStringArray(req.query["tags[]"]),
      ],
      scope: firstQueryString(req.query.scope),
      include: [
        ...queryStringArray(req.query.include),
        ...queryStringArray(req.query["include[]"]),
      ],
      folderId: firstQueryString(req.query.folderId),
      includeSubtree: optionalQueryBoolean(req.query.includeSubtree),
    }), viewer);
    res.json(result);
  });

  router.get("/companies/:companyId/skills/categories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.categoryCounts(companyId));
  });

  router.get("/companies/:companyId/skills/pending-approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pending = await svc.listPendingApprovals(companyId);
    if (isPrivilegedMemberViewer(req, companyId, true)) {
      res.json(pending);
      return;
    }
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    res.json(pending.filter((s) => s.createdByUserId === userId));
  });

  router.get("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.detail(companyId, skillId, skillActor(req));
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  // ---- Skill approval (review queue) ----
  router.post("/companies/:companyId/skills/:skillId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can review skills" });
      return;
    }
    const reviewerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const row = await svc.setApprovalStatus(companyId, skillId, "approved", reviewerUserId, null);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json(row);
  });

  router.post("/companies/:companyId/skills/:skillId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can review skills" });
      return;
    }
    const reviewerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const note = typeof (req.body as Record<string, unknown>)?.note === "string"
      ? ((req.body as Record<string, unknown>).note as string)
      : null;
    const row = await svc.setApprovalStatus(companyId, skillId, "rejected", reviewerUserId, note);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json(row);
  });

  // ---- Skill sharing: private-access members ----
  router.get("/companies/:companyId/skills/:skillId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listSkillAccessMembers(companyId, skillId));
  });

  router.post("/companies/:companyId/skills/:skillId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
    const principalId = String((req.body as Record<string, unknown>)?.principalId ?? "").trim();
    if (!principalId) {
      res.status(400).json({ error: "principalId is required" });
      return;
    }
    res.status(201).json(await svc.addSkillAccessMember(companyId, skillId, principalId));
  });

  router.delete("/companies/:companyId/skills/:skillId/members/:principalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const principalId = req.params.principalId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
    const removed = await svc.removeSkillAccessMember(companyId, skillId, principalId);
    if (!removed) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.json(removed);
  });

  router.get("/companies/:companyId/skills/:skillId/fork-precheck", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.forkPrecheck(companyId, skillId, skillActor(req));
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listVersions(companyId, skillId));
  });

  router.get("/companies/:companyId/skills/:skillId/versions/:versionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const versionId = req.params.versionId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getVersion(companyId, skillId, versionId);
    if (!result) {
      res.status(404).json({ error: "Skill version not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/test-inputs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTestInputs(companyId, skillId));
  });

  router.post(
    "/companies/:companyId/skills/:skillId/test-inputs",
    validate(companySkillTestInputCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.createTestInput(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_test_input_created",
        entityType: "company_skill_test_input",
        entityId: result.id,
        details: { skillId, name: result.name },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/test-inputs/:inputId",
    validate(companySkillTestInputUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      const inputId = req.params.inputId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateTestInput(companyId, skillId, inputId, req.body);
      if (!result) {
        res.status(404).json({ error: "Test input not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_test_input_updated",
        entityType: "company_skill_test_input",
        entityId: result.id,
        details: { skillId, changedKeys: Object.keys(req.body).sort() },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId/test-inputs/:inputId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const inputId = req.params.inputId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
    const result = await svc.deleteTestInput(companyId, skillId, inputId);
    if (!result) {
      res.status(404).json({ error: "Test input not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_test_input_deleted",
      entityType: "company_skill_test_input",
      entityId: result.id,
      details: { skillId, name: result.name },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skill-test-run-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTestRunTemplates(companyId));
  });

  router.post(
    "/companies/:companyId/skill-test-run-templates",
    validate(companySkillTestRunTemplateCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit");
      const result = await svc.createTestRunTemplate(companyId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_test_run_template_created",
        entityType: "company_skill_test_run_template",
        entityId: result.id,
        details: { name: result.name },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skill-test-run-templates/:templateId",
    validate(companySkillTestRunTemplateUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const templateId = req.params.templateId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit");
      const result = await svc.updateTestRunTemplate(companyId, templateId, req.body, skillActor(req));
      if (!result) {
        res.status(404).json({ error: "Test run template not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_test_run_template_updated",
        entityType: "company_skill_test_run_template",
        entityId: result.id,
        details: { changedKeys: Object.keys(req.body).sort() },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skill-test-run-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.edit");
    const result = await svc.deleteTestRunTemplate(companyId, templateId);
    if (!result) {
      res.status(404).json({ error: "Test run template not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_test_run_template_deleted",
      entityType: "company_skill_test_run_template",
      entityId: result.id,
      details: { name: result.name },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/test-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const query = companySkillTestRunListQuerySchema.parse({
      inputId: firstQueryString(req.query.inputId),
    });
    res.json(await svc.listTestRuns(companyId, skillId, query));
  });

  router.get("/companies/:companyId/skills/:skillId/test-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getTestRunDetail(companyId, skillId, runId);
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/test-runs",
    validate(companySkillTestRunCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
      await assertCanOrchestrateSkillTestHarness(req, companyId, {
        assigneeAgentId: req.body.agentId,
      });
      const actor = getActorInfo(req);
      const result = await svc.createTestRun(companyId, skillId, req.body, skillActor(req), {
        createHarnessIssue: async (harnessIssue) => {
          const created = await issues.create(companyId, {
            ...harnessIssue,
            priority: "medium",
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            actorRunId: actor.runId,
          });
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "issue.created",
            entityType: "issue",
            entityId: created.id,
            details: {
              title: created.title,
              identifier: created.identifier,
              harnessKind: "skill_test",
              source: "company_skill_test_run",
              skillId,
            },
          });
          return { id: created.id };
        },
        wakeHarnessIssue: async (issueId, agentId) => heartbeat.wakeup(agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "skill_test_run_created",
          payload: { issueId, skillId },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId, source: "company.skill_test_run" },
        }),
        cleanupHarnessIssue: async (issueId) => {
          const issue = await issues.getById(issueId);
          if (!issue || issue.companyId !== companyId) return;
          await issues.update(issueId, {
            status: "cancelled",
            hiddenAt: new Date(),
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          });
          await logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "company.skill_test_harness_issue_cleaned_up",
            entityType: "issue",
            entityId: issueId,
            details: { skillId },
          });
        },
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_test_run_created",
        entityType: "company_skill_test_run",
        entityId: result.id,
        issueId: result.issueId,
        details: {
          skillId,
          inputId: result.inputId,
          skillVersionId: result.skillVersionId,
          agentId: result.agentId,
          issueId: result.issueId,
        },
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/skills/:skillId/test-runs/:runId/cancel", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
    await assertCanOrchestrateSkillTestHarness(req, companyId, await loadSkillTestRunAssignmentScope(companyId, skillId, runId));
    const actor = getActorInfo(req);
    const result = await svc.cancelTestRun(companyId, skillId, runId, {
      cancelHarnessIssue: async (issueId) => {
        const issue = await issues.getById(issueId);
        if (!issue || issue.companyId !== companyId) return;
        if (issue.executionRunId) {
          await heartbeat.cancelRun(issue.executionRunId, "Cancelled by skill test run request");
        }
        if (issue.status !== "done" && issue.status !== "cancelled") {
          await issues.update(issueId, {
            status: "cancelled",
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
          });
        }
      },
    });
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_test_run_cancelled",
      entityType: "company_skill_test_run",
      entityId: result.id,
      issueId: result.issueId,
      details: { skillId, issueId: result.issueId },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/skills/:skillId/test-runs/:runId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const runId = req.params.runId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
    await assertCanOrchestrateSkillTestHarness(req, companyId, await loadSkillTestRunAssignmentScope(companyId, skillId, runId));
    const actor = getActorInfo(req);
    const result = await svc.deleteTestRun(companyId, skillId, runId, {
      hideHarnessIssue: async (issueId) => {
        const issue = await issues.getById(issueId);
        if (!issue || issue.companyId !== companyId) return;
        await issues.update(issueId, {
          hiddenAt: new Date(),
          actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
        });
      },
    });
    if (!result) {
      res.status(404).json({ error: "Test run not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_test_run_deleted",
      entityType: "company_skill_test_run",
      entityId: result.id,
      issueId: result.issueId,
      details: { skillId, issueId: result.issueId },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/versions",
    validate(companySkillVersionCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.create", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.createVersion(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_version_created",
        entityType: "company_skill_version",
        entityId: result.id,
        details: {
          skillId,
          revisionNumber: result.revisionNumber,
          label: result.label,
        },
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.starSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_starred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.unstarSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_unstarred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/fork",
    validate(companySkillForkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(
        req,
        companyId,
        "skills.create",
        () => skillPolicyResource({ companyId, skillId }),
      );
      const result = await svc.forkSkill(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_forked",
        entityType: "company_skill",
        entityId: result.skill.id,
        details: {
          sourceSkillId: skillId,
          slug: result.skill.slug,
          name: result.skill.name,
          reassignedAgentIds: result.reassignments.map((entry: { agentId: string }) => entry.agentId),
        },
      });
      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/skills/:skillId/comments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listComments(companyId, skillId));
  });

  router.post(
    "/companies/:companyId/skills/:skillId/comments",
    validate(companySkillCommentCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createComment(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_comment_created",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId, parentCommentId: result.parentCommentId },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/comments/:commentId",
    validate(companySkillCommentUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      const commentId = req.params.commentId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateComment(companyId, skillId, commentId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_comment_updated",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId/comments/:commentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const commentId = req.params.commentId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.deleteComment(companyId, skillId, commentId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_comment_deleted",
      entityType: "company_skill_comment",
      entityId: result.id,
      details: { skillId },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/update-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.updateStatus(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    assertCompanyAccess(req, companyId);
    const result = await svc.readFile(companyId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills",
    validate(companySkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanCreateCompanySkill(req, companyId);
      const allowRestrictedFolders = await actorAllowsRestrictedFolders(req);
      const result = await svc.createLocalSkill(companyId, req.body, skillActor(req), {
        isPrivileged: isPrivilegedMemberViewer(req, companyId, true),
        allowRestrictedFolders,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      // Equip logic (best-effort; never fails the create). Two triggers:
      //  1. An AGENT authoring a skill always auto-equips ITSELF, closing the
      //     "propose → solve → skillify → equipped" loop.
      //  2. equipOnCreate (from the UI checkbox) equips every agent in the
      //     skill's sharing scope (company / team / private).
      if (actor.actorType === "agent" && actor.agentId) {
        await equipSkillToAgents(companyId, result.key, [actor.agentId], actor.agentId);
      }
      if (req.body.equipOnCreate) {
        const targets = await resolveEquipTargets(
          companyId,
          result.sharingScope ?? "company",
          result.sharingTeams ?? [],
          actor.actorType === "user" ? actor.actorId : null,
          actor.agentId ?? null,
        );
        await equipSkillToAgents(companyId, result.key, targets, actor.agentId ?? null);
      }
      // Explicitly-picked agents to share with (the private "share with these agents"
      // dropdown). Equip them, and for a private skill also add their owner user(s)
      // as access members so the skill is VISIBLE to them.
      const equipAgentIds = Array.isArray(req.body.equipAgentIds)
        ? (req.body.equipAgentIds as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
      if (equipAgentIds.length > 0) {
        await equipSkillToAgents(companyId, result.key, equipAgentIds, actor.agentId ?? null);
        if (result.sharingScope === "private") {
          try {
            const ownerRows = await db
              .select({ userId: agentMemberships.userId })
              .from(agentMemberships)
              .where(and(
                eq(agentMemberships.companyId, companyId),
                inArray(agentMemberships.agentId, equipAgentIds),
                eq(agentMemberships.state, "joined"),
              ));
            for (const userId of new Set(ownerRows.map((r) => r.userId))) {
              await svc.addSkillAccessMember(companyId, result.id, userId);
            }
          } catch (err) {
            console.warn(`[skills] private share access-member grant failed for ${result.key}:`, err);
          }
        }
      }

      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId",
    validate(companySkillUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateSkill(companyId, skillId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_updated",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          categories: result.categories,
          sharingScope: result.sharingScope,
        },
      });

      res.json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
        skillActor(req),
      );

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.delete(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileDeleteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.edit", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.deleteFile(companyId, skillId, req.body, skillActor(req));

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_file_deleted",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          target: result.target,
          deletedPaths: result.deletedPaths,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import",
    validate(companySkillImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const source = String(req.body.source ?? "");
      await assertCanMutateCompanySkills(req, companyId, "skills.import", () => skillImportPolicyResource(source));
      const result = await svc.importFromSource(companyId, source);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skills_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
        },
      });
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        for (const skill of result.imported) {
          trackSkillImported(telemetryClient, {
            sourceType: skill.sourceType,
            skillRef: deriveTrackedSkillRef(skill),
          });
        }
      }

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/install-catalog",
    validate(companySkillInstallCatalogSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.install", {
        sourceType: "catalog",
        sourceLocator: req.body.catalogSkillId,
      });
      const result = await svc.installFromCatalog(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: result.action === "created" ? "company.skill_catalog_installed" : "company.skill_catalog_updated",
        entityType: "company_skill",
        entityId: result.skill.id,
        details: {
          action: result.action,
          catalogId: result.catalogSkill.id,
          catalogKey: result.catalogSkill.key,
          slug: result.skill.slug,
          originHash: result.catalogSkill.contentHash,
          warningCount: result.warnings.length,
        },
      });

      res.status(result.action === "created" ? 201 : 200).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/scan-projects",
    validate(companySkillProjectScanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.import", { sourceType: "workspace" });
      const result = await svc.scanProjectWorkspaces(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skills_scanned",
        entityType: "company",
        entityId: companyId,
        details: {
          mode: req.body.mode ?? "import",
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          candidateCount: result.candidates.length,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.remove", () => skillPolicyResource({ companyId, skillId }));
    const force = req.query.force === "true" || req.query.force === "1";
    const result = await svc.deleteSkill(companyId, skillId, { force });
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "company.skill_deleted",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/audit",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.test", () => skillPolicyResource({ companyId, skillId }));
      const result = await svc.auditSkill(companyId, skillId);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_audited",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          verdict: result.verdict,
          codes: result.codes,
          installedHash: result.installedHash,
          originHash: result.originHash,
          scanVersion: result.scanVersion,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/install-update",
    validate(companySkillInstallUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.update", () => skillPolicyResource({ companyId, skillId }));
      const before = await svc.getById(companyId, skillId);
      const result = await svc.installUpdate(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_update_installed",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/reset",
    validate(companySkillResetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId, "skills.reset", () => skillPolicyResource({ companyId, skillId }));
      const before = await svc.getById(companyId, skillId);
      const result = await svc.resetSkill(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.skill_reset",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  // The teams the current user can share a skill with (their joined agents''' teams).
  router.get("/companies/:companyId/my-teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    if (!userId) { res.json({ teams: [] }); return; }
    const teams = await svc.getUserTeams(companyId, userId);
    res.json({ teams: [...teams].sort() });
  });

  // ---- Folder registry (scoped, user-created folders) ----
  router.get("/companies/:companyId/skill-folders", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const viewer = req.actor.type === "board"
      ? { userId: req.actor.userId ?? null, isPrivileged: isPrivilegedMemberViewer(req, companyId, true) }
      : { isPrivileged: true }; // agents aren't scope-filtered here
    res.json(await svc.listSkillFolders(companyId, viewer));
  });

  router.post(
    "/companies/:companyId/skill-folders",
    validate(companySkillFolderCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanCreateCompanySkill(req, companyId);
      // The reserved numbered folders (00–10 …) may only be created by founder/Jay.
      if (/^\s*\d{2}[\s-]/.test(String(req.body.name ?? "")) && !(await actorAllowsRestrictedFolders(req))) {
        res.status(403).json({ error: "That folder name is reserved." });
        return;
      }
      const createdByUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
      const result = await svc.createSkillFolder(companyId, req.body, createdByUserId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_folder_created",
        entityType: "company",
        entityId: companyId,
        details: { folderId: result.id, name: result.name, scope: result.scope },
      });
      res.status(201).json(result);
    },
  );

  // Only the folder's creator or a privileged member (owner/admin) may change or
  // remove a folder; the reserved numbered taxonomy stays founder/Jay-only.
  async function assertCanManageFolder(req: Request, companyId: string, folder: { name: string; createdByUserId: string | null }) {
    const isPrivileged = isPrivilegedMemberViewer(req, companyId, true);
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const isCreator = !!userId && folder.createdByUserId === userId;
    if (!isPrivileged && !isCreator) {
      throw forbidden("You can only manage folders you created.");
    }
    if (/^\s*\d{2}[\s-]/.test(folder.name) && !(await actorAllowsRestrictedFolders(req))) {
      throw forbidden("That folder is reserved.");
    }
  }

  router.patch(
    "/companies/:companyId/skill-folders/:folderId",
    validate(companySkillFolderUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const folderId = req.params.folderId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getSkillFolderById(companyId, folderId);
      if (!existing) {
        res.status(404).json({ error: "Folder not found" });
        return;
      }
      await assertCanManageFolder(req, companyId, existing);
      // Renaming to a reserved numbered name is likewise founder/Jay-only.
      if (req.body.name && /^\s*\d{2}[\s-]/.test(String(req.body.name)) && !(await actorAllowsRestrictedFolders(req))) {
        res.status(403).json({ error: "That folder name is reserved." });
        return;
      }
      const result = await svc.updateSkillFolder(companyId, folderId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_folder_updated",
        entityType: "company",
        entityId: companyId,
        details: { folderId: result.id, name: result.name, scope: result.scope },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skill-folders/:folderId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const existing = await svc.getSkillFolderById(companyId, folderId);
    if (!existing) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    await assertCanManageFolder(req, companyId, existing);
    const result = await svc.deleteSkillFolder(companyId, folderId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_folder_deleted",
      entityType: "company",
      entityId: companyId,
      details: { folderId, name: result.name, skillsUpdated: result.skillsUpdated },
    });
    res.json(result);
  });

  // ---- Virtual office: per-agent skill counts ----
  router.get("/companies/:companyId/agent-skill-counts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.agentSkillCounts(companyId));
  });

  // ---- Virtual office: per-agent progression (level + 15 badges) ----
  const agentProgression = agentProgressionService(db);
  router.get("/companies/:companyId/agent-progression", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await agentProgression.computeForCompany(companyId));
  });

  // ---- Leaderboard (排行榜) ----
  const leaderboard = leaderboardService(db);
  const notifications = notificationService(db);

  router.get("/companies/:companyId/leaderboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const periodParam = typeof req.query.period === "string" ? req.query.period : null;
    const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : null; // null = lifetime
    const result = await leaderboard.compute(companyId, period);
    // Resolve display names for the ranked users.
    const userIds = result.entries.map((e) => e.userId).filter(Boolean);
    const users = userIds.length
      ? await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
          .from(authUsers).where(inArray(authUsers.id, userIds))
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id.slice(0, 8)]));
    // Frozen awards for the requested month (lifetime view → current month).
    const awardsMonth = period ?? new Date().toISOString().slice(0, 7);
    const awards = await leaderboard.listAwards(companyId, awardsMonth);
    res.json({
      period: result.period,
      // Attach the Virtual Office progression (XP/level/title/coins/badges),
      // computed purely from each entry. coinsSpent is 0 until the shop ships.
      entries: result.entries.map((e) => ({
        ...e,
        displayName: nameById.get(e.userId) ?? e.userId.slice(0, 8),
        progression: progressionFor(e),
      })),
      awards,
    });
  });

  // Manually run the monthly rollup (admin) — freezes that month's award winners.
  router.post("/companies/:companyId/leaderboard/rollup", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateCompanySkills(req, companyId, "skills.update");
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can run the rollup" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const period = typeof body.period === "string" && /^\d{4}-\d{2}$/.test(body.period)
      ? body.period
      : new Date().toISOString().slice(0, 7);
    const winners = await leaderboard.runMonthlyRollup(companyId, period);
    res.json({ period, winners });
  });

  // Record one use of a skill (agents/automations call this when they use a skill).
  router.post("/companies/:companyId/skills/:skillId/record-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const periodMonth = typeof body.periodMonth === "string" && /^\d{4}-\d{2}$/.test(body.periodMonth)
      ? body.periodMonth
      : new Date().toISOString().slice(0, 7);
    const usedByUserId = req.actor.type === "board" ? req.actor.userId ?? null : (typeof body.usedByUserId === "string" ? body.usedByUserId : null);
    const usedByAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : (typeof body.usedByAgentId === "string" ? body.usedByAgentId : null);
    const increment = typeof body.increment === "number" && body.increment > 0 ? Math.min(1000, Math.round(body.increment)) : 1;
    const row = await leaderboard.recordUsage(companyId, skillId, periodMonth, usedByUserId, usedByAgentId, increment);

    // Reward loop: when a real user adopts someone else's skill, notify the
    // author — once per adopter (deduped), so repeat uses never spam. Best-effort:
    // a notification failure must never break usage recording.
    if (usedByUserId) {
      try {
        const [skill] = await db
          .select({ name: companySkills.name, author: companySkills.createdByUserId })
          .from(companySkills)
          .where(eq(companySkills.id, skillId))
          .limit(1);
        if (skill?.author && skill.author !== usedByUserId) {
          const [user] = await db
            .select({ name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, usedByUserId))
            .limit(1);
          const who = user?.name ?? user?.email ?? "有人 / Someone";
          await notifications.create({
            companyId,
            userId: skill.author,
            kind: "office_skill_adopted",
            title: `🎉 ${who} 用了你的技能 / used your skill`,
            body: `《${skill.name}》被採用了——你的自動化正在幫團隊省時間。 / Your automation is saving the team time.`,
            link: "/virtual-office",
            dedupeKey: `office-skill-adopted:${skillId}:${usedByUserId}`,
          });
        }
      } catch {
        /* notifications are best-effort */
      }
    }

    res.json(row);
  });

  return router;
}
