import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentMemberships,
  projectAccessMembers,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issueComments,
  issues,
  principalPermissionGrants,
  projects,
  companySecrets,
  companySecretBindings,
  userInboxAgentPolicies,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type PermissionKey } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { authorizationService } from "../services/authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createCompany(db: ReturnType<typeof createDb>, label: string) {
  return db
    .insert(companies)
    .values({
      name: `Authorization ${label} ${randomUUID()}`,
      issuePrefix: `AZ${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: { role?: string; reportsTo?: string | null; permissions?: Record<string, unknown> } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: input.role ?? "engineer",
      reportsTo: input.reportsTo ?? null,
      permissions: input.permissions ?? {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createProject(db: ReturnType<typeof createDb>, companyId: string, label: string) {
  return db
    .insert(projects)
    .values({
      companyId,
      name: `Project ${label} ${randomUUID()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createIssue(
  db: ReturnType<typeof createDb>,
  companyId: string,
  input: {
    id?: string;
    title?: string;
    projectId?: string | null;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    originKind?: string | null;
    originId?: string | null;
  } = {},
) {
  return db
    .insert(issues)
    .values({
      id: input.id ?? randomUUID(),
      companyId,
      title: input.title ?? `Issue ${randomUUID()}`,
      status: "todo",
      priority: "medium",
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function grantAgentPermission(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  permissionKey: PermissionKey,
  scope: Record<string, unknown> | null = null,
) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    status: "active",
    membershipRole: "member",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "agent",
    principalId: agentId,
    permissionKey,
    scope,
    grantedByUserId: null,
  });
}

async function createUser(
  db: ReturnType<typeof createDb>,
  input: { id?: string; email?: string } = {},
) {
  const id = input.id ?? `user-${randomUUID()}`;
  await db.insert(authUsers).values({
    id,
    name: `User ${id}`,
    email: input.email ?? `${id}@example.com`,
    emailVerified: true,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

async function grantUserPermission(
  db: ReturnType<typeof createDb>,
  companyId: string,
  userId: string,
  permissionKey: PermissionKey,
  scope: Record<string, unknown> | null = null,
) {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "operator",
  });
  await db.insert(principalPermissionGrants).values({
    companyId,
    principalType: "user",
    principalId: userId,
    permissionKey,
    scope,
    grantedByUserId: "owner",
  });
}

describeEmbeddedPostgres("authorization service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-authorization-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    // Secret rows reference companies without a cascade, so they have to go
    // before the company does or the whole teardown fails and takes the next
    // several cases with it.
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(userInboxAgentPolicies);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows active user role grants and explains the grant source", async () => {
    const company = await createCompany(db, "UserGrant");
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      permissionKey: "tasks:assign",
      grantedByUserId: "owner",
    });

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      action: "tasks:assign",
      permissionKey: "tasks:assign",
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
      grant: {
        principalType: "user",
        principalId: userId,
        permissionKey: "tasks:assign",
      },
    });
    expect(decision.explanation).toContain("Allowed by explicit grant tasks:assign");
  });

  it("allows suggest grants to read peer agent configuration", async () => {
    const company = await createCompany(db, "AgentReadGrant");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "agents:suggest-changes");

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
      grant: {
        principalType: "agent",
        principalId: actorAgent.id,
        permissionKey: "agents:suggest-changes",
      },
    });
  });

  it("falls back to the direct config-read grant decision when a suggest read grant is scoped away", async () => {
    const company = await createCompany(db, "AgentReadScopedSuggestGrant");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "agents:suggest-changes", {
      projectId: randomUUID(),
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_missing_grant",
      explanation: "Missing permission: agents:configure.",
    });
  });

  it("enforces direct or consented suggest grants for agent configuration changes", async () => {
    const company = await createCompany(db, "AgentChangeGrant");
    const directAgent = await createAgent(db, company.id);
    const suggestAgent = await createAgent(db, company.id);
    const noGrantAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, directAgent.id, "agents:configure");
    await grantAgentPermission(db, company.id, suggestAgent.id, "agents:suggest-changes");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: noGrantAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const authz = authorizationService(db);
    await expect(authz.decide({
      actor: { type: "agent", agentId: directAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
      scope: { requiresChangeGrant: true },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_direct_change",
      grant: { permissionKey: "agents:configure" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: suggestAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
      scope: { requiresChangeGrant: true },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_missing_consent",
      grant: { permissionKey: "agents:suggest-changes" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: suggestAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
      scope: { requiresChangeGrant: true, consentedChange: true },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_consented_change",
      grant: { permissionKey: "agents:suggest-changes" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: noGrantAgent.id, companyId: company.id, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
      scope: { requiresChangeGrant: true },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_no_grant",
    });
  });

  it("enforces direct or consented suggest grants for skill configuration changes", async () => {
    const company = await createCompany(db, "SkillChangeGrant");
    const directAgent = await createAgent(db, company.id);
    const suggestAgent = await createAgent(db, company.id);
    const noGrantAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, directAgent.id, "skills:create");
    await grantAgentPermission(db, company.id, suggestAgent.id, "skills:suggest-changes");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: noGrantAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const authz = authorizationService(db);
    await expect(authz.decide({
      actor: { type: "agent", agentId: directAgent.id, companyId: company.id, source: "agent_key" },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_direct_change",
      grant: { permissionKey: "skills:create" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: suggestAgent.id, companyId: company.id, source: "agent_key" },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_missing_consent",
      grant: { permissionKey: "skills:suggest-changes" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: suggestAgent.id, companyId: company.id, source: "agent_key" },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
      scope: { consentedChange: true },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_consented_change",
      grant: { permissionKey: "skills:suggest-changes" },
    });

    await expect(authz.decide({
      actor: { type: "agent", agentId: noGrantAgent.id, companyId: company.id, source: "agent_key" },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_no_grant",
    });
  });

  it("allows board users with direct skills:create grants to mutate company skills", async () => {
    const company = await createCompany(db, "BoardUserSkillGrant");
    const userId = await createUser(db);
    await grantUserPermission(db, company.id, userId, "skills:create");

    const decision = await authorizationService(db).decide({
      actor: {
        type: "board",
        userId,
        companyIds: [company.id],
        source: "session",
      },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_direct_change",
      grant: {
        principalType: "user",
        principalId: userId,
        permissionKey: "skills:create",
      },
    });
  });

  it("allows responsible-user JWT agents with direct skills:create grants to mutate company skills", async () => {
    const company = await createCompany(db, "ResponsibleUserSkillGrant");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "skills:create");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_direct_change",
      grant: {
        principalType: "agent",
        principalId: actorAgent.id,
        permissionKey: "skills:create",
      },
    });
  });

  it("keeps responsible-user skill mutations denied for viewer memberships", async () => {
    const company = await createCompany(db, "ResponsibleUserSkillViewerDenied");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "skills:create");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "viewer",
    });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
    expect(decision.explanation).toContain(`Responsible user ${responsibleUserId} is not authorized`);
  });

  it("denies cross-company agent decisions before grant evaluation", async () => {
    const sourceCompany = await createCompany(db, "Source");
    const targetCompany = await createCompany(db, "Target");
    const actorAgent = await createAgent(db, sourceCompany.id);

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_jwt" },
      action: "tasks:assign",
      resource: { type: "company", companyId: targetCompany.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
    expect(decision.explanation).toContain("Agent key cannot access another company");
  });

  it("allows simple-mode task assignment between same-company agents without explicit grants", async () => {
    const company = await createCompany(db, "AssignmentDefault");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_simple_company_member",
    });
    expect(decision.explanation).toContain("simple mode");
  });

  it("denies delegated protected assignment when the responsible user lacks matching authority", async () => {
    const company = await createCompany(db, "ResponsibleUserDenied");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const ceoAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "protected" },
        },
      },
    });
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: ceoAgent.id },
      scope: { assigneeAgentId: ceoAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
    });
  });

  it("allows active non-viewer responsible users to authorize assigned agent issue mutations", async () => {
    const company = await createCompany(db, "ResponsibleUserIssueMutation");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Assigned issue mutation",
      assigneeAgentId: actorAgent.id,
    });
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        assigneeAgentId: actorAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_self",
    });
  });

  it("keeps responsible-user issue mutations denied for viewer memberships", async () => {
    const company = await createCompany(db, "ResponsibleUserIssueViewerDenied");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Assigned viewer-denied mutation",
      assigneeAgentId: actorAgent.id,
    });
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "viewer",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        assigneeAgentId: actorAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAUTHORIZED",
      reason: "deny_unsupported_action",
    });
  });

  it("fails closed when the responsible user is unavailable", async () => {
    const company = await createCompany(db, "ResponsibleUserUnavailable");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: `missing-${randomUUID()}`,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      code: "RESPONSIBLE_USER_UNAVAILABLE",
    });
  });

  it("allows delegated protected assignment when both agent and responsible user are authorized", async () => {
    const company = await createCompany(db, "ResponsibleUserAllowed");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const ceoAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: { mode: "protected" },
        },
      },
    });
    const responsibleUserId = await createUser(db);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");
    await grantUserPermission(db, company.id, responsibleUserId, "tasks:assign");

    const decision = await authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: ceoAgent.id },
      scope: { assigneeAgentId: ceoAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
    });
  });

  it("limits low-trust issue reads to the configured project and root issue boundary", async () => {
    const company = await createCompany(db, "LowTrustIssueReads");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const rootIssueId = randomUUID();
    const actorAgent = await createAgent(db, company.id, {
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            projectIds: [project.id],
            rootIssueId,
          },
        },
      },
    });
    const rootIssue = await createIssue(db, company.id, {
      id: rootIssueId,
      projectId: project.id,
      assigneeAgentId: actorAgent.id,
    });
    const childIssue = await createIssue(db, company.id, {
      projectId: project.id,
      parentId: rootIssue.id,
    });
    const unrelatedIssue = await createIssue(db, company.id, {
      projectId: otherProject.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent" as const, agentId: actorAgent.id, companyId: company.id, source: "agent_key" as const };
    const rootDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: rootIssue.id,
        projectId: rootIssue.projectId,
        parentIssueId: rootIssue.parentId,
        assigneeAgentId: rootIssue.assigneeAgentId,
        status: rootIssue.status,
      },
    });
    const childDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: childIssue.id,
        projectId: childIssue.projectId,
        parentIssueId: childIssue.parentId,
        status: childIssue.status,
      },
    });
    const unrelatedDecision = await authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: unrelatedIssue.id,
        projectId: unrelatedIssue.projectId,
        parentIssueId: unrelatedIssue.parentId,
        status: unrelatedIssue.status,
      },
    });

    expect(rootDecision).toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    expect(childDecision).toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    expect(unrelatedDecision).toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("blocks low-trust project, agent, company-wide, and outside-boundary assignment access", async () => {
    const company = await createCompany(db, "LowTrustOtherResources");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const collaborator = await createAgent(db, company.id);
    const higherTrustAgent = await createAgent(db, company.id, { role: "cto" });
    const actorAgent = await createAgent(db, company.id, {
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            projectIds: [project.id],
            allowedAgentIds: [collaborator.id],
          },
        },
      },
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent" as const, agentId: actorAgent.id, companyId: company.id, source: "agent_key" as const };

    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: project.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: otherProject.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: collaborator.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: higherTrustAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        projectId: project.id,
        assigneeAgentId: higherTrustAgent.id,
      },
      scope: { projectId: project.id, assigneeAgentId: higherTrustAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("blocks low-trust configuration actions before evaluating explicit change grants", async () => {
    const company = await createCompany(db, "LowTrustConfigGrants");
    const project = await createProject(db, company.id, "Allowed");
    const targetAgent = await createAgent(db, company.id);
    const actorAgent = await createAgent(db, company.id, {
      role: "ceo",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [project.id],
            allowedAgentIds: [targetAgent.id],
          },
        },
      },
    });
    await grantAgentPermission(db, company.id, actorAgent.id, "agents:configure");
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      permissionKey: "skills:create",
      grantedByUserId: null,
    });

    const authz = authorizationService(db);
    const actor = { type: "agent" as const, agentId: actorAgent.id, companyId: company.id, source: "agent_key" as const };

    await expect(authz.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_low_trust_boundary" });

    await expect(authz.decide({
      actor,
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    await expect(authz.decide({
      actor,
      action: "agent_config:read",
      resource: { type: "agent", companyId: company.id, agentId: actorAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    await expect(authz.decide({
      actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
      scope: { requiresChangeGrant: true, consentedChange: true },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    await expect(authz.decide({
      actor,
      action: "skill_config:update",
      resource: { type: "company", companyId: company.id },
      scope: { consentedChange: true },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("denies simple-mode assignment when the target agent requires protected-assignment approval", async () => {
    const company = await createCompany(db, "ProtectedAssignment");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        authorizationPolicy: {
          assignmentPolicy: {
            mode: "protected",
            protectedAgentRequiresApproval: true,
          },
          protectedAgent: {
            requiresApproval: true,
            approvalReason: "Production deployment authority",
          },
          managedBy: "permissions-extension",
        },
      },
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_policy_restricted",
    });
    expect(decision.explanation).toContain("requires approval");
  });

  it("requires an explicit grant before assigning to a private target agent", async () => {
    const company = await createCompany(db, "PrivateAssignment");
    const actorAgent = await createAgent(db, company.id, { role: "engineer" });
    const targetAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        authorizationPolicy: {
          agentVisibility: {
            mode: "private",
            hiddenFromDefaultDirectory: true,
          },
          assignmentPolicy: {
            mode: "company_default",
            protectedAgentRequiresApproval: false,
          },
          protectedAgent: {
            requiresApproval: false,
          },
          managedBy: "permissions-extension",
        },
      },
    });

    const denied = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      assigneeAgentId: targetAgent.id,
    });

    const allowed = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_policy_restricted",
    });
    expect(denied.explanation).toContain("private");
    expect(allowed).toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
      grant: { permissionKey: "tasks:assign_scope" },
    });
  });

  it("allows simple-mode task assignment for active same-company board operators without explicit grants", async () => {
    const company = await createCompany(db, "BoardAssignmentDefault");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId, source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_simple_company_member",
    });
  });

  it("allows null-mapped visibility actions for active same-company board members", async () => {
    const company = await createCompany(db, "BoardVisibility");
    const userId = `user-${randomUUID()}`;
    const project = await createProject(db, company.id, "Visible");
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, { projectId: project.id });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);
    const actor = { type: "board" as const, userId, source: "session" as const };

    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: project.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        status: issue.status,
      },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "runtime:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "secrets:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
  });

  it("denies null-mapped visibility actions for board users without an active membership", async () => {
    const memberCompany = await createCompany(db, "BoardVisibilityMember");
    const otherCompany = await createCompany(db, "BoardVisibilityOther");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, otherCompany.id, { role: "engineer" });
    const inactiveUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: memberCompany.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(companyMemberships).values({
      companyId: otherCompany.id,
      principalType: "user",
      principalId: inactiveUserId,
      status: "removed",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "agent:read",
      resource: { type: "agent", companyId: otherCompany.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
    await expect(authorization.decide({
      actor: { type: "board", userId: inactiveUserId, source: "session" },
      action: "company_scope:read",
      resource: { type: "company", companyId: otherCompany.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_membership" });
  });

  it("keeps denying self-gated null-mapped actions for board members", async () => {
    const company = await createCompany(db, "BoardWakeDenied");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });

    const authorization = authorizationService(db);

    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "agent:wake",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unsupported_action",
    });
    const issue = await createIssue(db, company.id, { title: "Wake denied issue" });
    await expect(authorization.decide({
      actor: { type: "board", userId, source: "session" },
      action: "issue:mutate",
      resource: { type: "issue", companyId: company.id, issueId: issue.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unsupported_action",
    });
  });

  it("allows mentioned agents to read and comment on assigned issues without granting issue mutation", async () => {
    const company = await createCompany(db, "MentionCommentAuth");
    const allowedProject = await createProject(db, company.id, "MentionAllowed");
    const targetProject = await createProject(db, company.id, "MentionTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped comment target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    const deletedMention = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `[@Mentioned Agent](agent://${mentionedAgent.id}) this deleted comment should not count`,
      deletedAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    expect(deletedMention.id).toBeTruthy();

    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });

    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `[@Mentioned Agent](agent://${mentionedAgent.id}) please respond here`,
      authorAgentId: ownerAgent.id,
    });

    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
    await expect(authorization.decide({
      actor,
      action: "issue:mutate",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("allows a mentioned non-assignee to comment when the mention author is the issue assignee", async () => {
    const company = await createCompany(db, "MentionCommentAssigneeGrant");
    const allowedProject = await createProject(db, company.id, "MentionAssigneeAllowed");
    const targetProject = await createProject(db, company.id, "MentionAssigneeTarget");
    const assigneeAgent = await createAgent(db, company.id, { role: "coach" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "qa",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Assignee-authored mention reply target",
      projectId: targetProject.id,
      assigneeAgentId: assigneeAgent.id,
    });
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      authorAgentId: assigneeAgent.id,
      authorType: "agent",
      body: `[@QA](agent://${mentionedAgent.id}) please reply on this issue.`,
    });

    await expect(authorizationService(db).decide({
      actor: { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" },
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: issue.id,
        projectId: issue.projectId,
        assigneeAgentId: assigneeAgent.id,
        status: issue.status,
      },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
  });

  it("does not grant mention-scoped issue access from self-authored or unauthorized-author comments", async () => {
    const company = await createCompany(db, "MentionCommentDenied");
    const allowedProject = await createProject(db, company.id, "MentionDeniedAllowed");
    const targetProject = await createProject(db, company.id, "MentionDeniedTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const unrelatedAgent = await createAgent(db, company.id, { role: "engineer" });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped comment denial target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });

    const authorization = authorizationService(db);
    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await db.insert(issueComments).values([
      {
        companyId: company.id,
        issueId: issue.id,
        body: `Self mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
        authorAgentId: mentionedAgent.id,
      },
      {
        companyId: company.id,
        issueId: issue.id,
        body: `Unauthorized mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
        authorAgentId: unrelatedAgent.id,
      },
    ]);

    await expect(authorization.decide({
      actor,
      action: "issue:read",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
    await expect(authorization.decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  it("allows active board-user comments to create mention-scoped issue grants", async () => {
    const company = await createCompany(db, "MentionCommentBoardGrant");
    const allowedProject = await createProject(db, company.id, "MentionBoardAllowed");
    const targetProject = await createProject(db, company.id, "MentionBoardTarget");
    const ownerAgent = await createAgent(db, company.id, { role: "engineer" });
    const mentionedAgent = await createAgent(db, company.id, {
      role: "engineer",
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [allowedProject.id],
          },
        },
      },
    });
    const issue = await createIssue(db, company.id, {
      title: "Mention-scoped board grant target",
      projectId: targetProject.id,
      assigneeAgentId: ownerAgent.id,
    });
    const boardUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(issueComments).values({
      companyId: company.id,
      issueId: issue.id,
      body: `Board mention [@Mentioned Agent](agent://${mentionedAgent.id})`,
      authorUserId: boardUserId,
    });

    const actor = { type: "agent", agentId: mentionedAgent.id, companyId: company.id, source: "agent_key" } as const;
    const resource = {
      type: "issue",
      companyId: company.id,
      issueId: issue.id,
      projectId: issue.projectId,
      assigneeAgentId: ownerAgent.id,
      status: issue.status,
    } as const;

    await expect(authorizationService(db).decide({
      actor,
      action: "issue:comment",
      resource,
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_issue_mention_grant",
    });
  });

  it("limits viewer members to read-only visibility actions", async () => {
    const company = await createCompany(db, "BoardViewerVisibility");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "viewer",
    });

    const authorization = authorizationService(db);
    const actor = { type: "board", userId, source: "session" } as const;

    await expect(authorization.decide({
      actor,
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: targetAgent.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    await expect(authorization.decide({
      actor,
      action: "runtime:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
    await expect(authorization.decide({
      actor,
      action: "secrets:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
  });

  it("denies legacy board assignment context for viewers", async () => {
    const company = await createCompany(db, "BoardViewerAssignment");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, company.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "viewer",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId, companyIds: [company.id], source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: company.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_missing_grant",
    });
  });

  it("never elevates cloud_tenant actors through stale instance_admin rows", async () => {
    const tenantCompany = await createCompany(db, "CloudTenantStale");
    const otherCompany = await createCompany(db, "CloudTenantOther");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, otherCompany.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: tenantCompany.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    // Stale grant left behind by a pre-hardening cloud_tenant deployment.
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });

    const decision = await authorizationService(db).decide({
      actor: {
        type: "board",
        userId,
        companyIds: [tenantCompany.id],
        isInstanceAdmin: false,
        source: "cloud_tenant",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: otherCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).not.toBe("allow_instance_admin");

    // Control: the instanceUserRoles lookup still elevates non-cloud_tenant
    // board actors, so the carve-out is scoped to the tenant contract only.
    const sessionDecision = await authorizationService(db).decide({
      actor: { type: "board", userId, companyIds: [tenantCompany.id], source: "session" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: otherCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });
    expect(sessionDecision).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
  });

  it("trusts the computed isInstanceAdmin flag on cloud_tenant actors", async () => {
    // The trusted-header resolver is the only code path that can set
    // isInstanceAdmin on a cloud_tenant actor (stack owner +
    // enableOwnerInstanceAdmin). The authorization service must honor the
    // computed flag without consulting instance_user_roles.
    const tenantCompany = await createCompany(db, "CloudTenantOwnerAdmin");
    const otherCompany = await createCompany(db, "CloudTenantOwnerAdminOther");
    const userId = `user-${randomUUID()}`;
    const targetAgent = await createAgent(db, otherCompany.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: tenantCompany.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    // Deliberately NO instanceUserRoles row: elevation is computed, not stored.

    const decision = await authorizationService(db).decide({
      actor: {
        type: "board",
        userId,
        companyIds: [tenantCompany.id],
        isInstanceAdmin: true,
        source: "cloud_tenant",
      },
      action: "tasks:assign",
      resource: { type: "issue", companyId: otherCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_instance_admin" });
  });

  it("denies simple-mode assignment to a target agent from another company", async () => {
    const sourceCompany = await createCompany(db, "AssignmentSource");
    const targetCompany = await createCompany(db, "AssignmentTarget");
    const actorAgent = await createAgent(db, sourceCompany.id, { role: "engineer" });
    const targetAgent = await createAgent(db, targetCompany.id, { role: "engineer" });
    await db.insert(companyMemberships).values({
      companyId: sourceCompany.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_key" },
      action: "tasks:assign",
      resource: { type: "issue", companyId: sourceCompany.id, assigneeAgentId: targetAgent.id },
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
  });

  it("preserves legacy CEO agent creator authority", async () => {
    const company = await createCompany(db, "Legacy");
    const actorAgent = await createAgent(db, company.id, { role: "ceo" });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_jwt" },
      action: "agents:create",
      resource: { type: "company", companyId: company.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reason: "allow_legacy_agent_creator",
    });
  });

  it("denies active-checkout management outside the CEO caller company scope", async () => {
    const sourceCompany = await createCompany(db, "CheckoutSource");
    const targetCompany = await createCompany(db, "CheckoutTarget");
    const actorAgent = await createAgent(db, sourceCompany.id, { role: "ceo" });
    const targetAgent = await createAgent(db, targetCompany.id, { role: "engineer" });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: sourceCompany.id, source: "agent_jwt" },
      action: "tasks:manage_active_checkouts",
      resource: { type: "issue", companyId: targetCompany.id, assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "deny_company_boundary",
    });
    expect(decision.explanation).toContain("another company");
  });

  it("allows scoped assignment inside a granted project and denies other projects", async () => {
    const company = await createCompany(db, "ProjectScope");
    const project = await createProject(db, company.id, "Allowed");
    const otherProject = await createProject(db, company.id, "Denied");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      projectIds: [project.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { projectId: project.id, assigneeAgentId: targetAgent.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { projectId: otherProject.id, assigneeAgentId: targetAgent.id },
    });

    expect(allowed).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign_scope" },
    });
    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
    expect(denied.explanation).toContain("does not cover the requested scope");
  });

  it("treats unknown grant scope metadata as unconstrained", async () => {
    const company = await createCompany(db, "UnknownScopeMetadata");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      note: "CEO-approved",
    });

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign_scope" },
    });
  });

  it("allows scoped assignment to agents inside a managed subtree only", async () => {
    const company = await createCompany(db, "SubtreeScope");
    const actorAgent = await createAgent(db, company.id);
    const managerAgent = await createAgent(db, company.id);
    const childAgent = await createAgent(db, company.id, { reportsTo: managerAgent.id });
    const grandchildAgent = await createAgent(db, company.id, { reportsTo: childAgent.id });
    const outsideAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      managedSubtreeAgentIds: [managerAgent.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: grandchildAgent.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: outsideAgent.id },
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.grant?.permissionKey).toBe("tasks:assign_scope");
    expect(denied).toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });

  it("allows scoped assignment to an explicit target-agent allowlist only", async () => {
    const company = await createCompany(db, "AllowlistScope");
    const actorAgent = await createAgent(db, company.id);
    const allowedTarget = await createAgent(db, company.id);
    const deniedTarget = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign_scope", {
      assigneeAgentIds: [allowedTarget.id],
    });

    const allowed = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: allowedTarget.id },
    });
    const denied = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentId: deniedTarget.id },
    });

    expect(allowed.allowed).toBe(true);
    expect(denied.allowed).toBe(false);
  });

  it("preserves unscoped tasks:assign compatibility for assignment decisions", async () => {
    const company = await createCompany(db, "BroadAssign");
    const actorAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    await grantAgentPermission(db, company.id, actorAgent.id, "tasks:assign");

    const decision = await authorizationService(db).decidePrincipalGrant({
      companyId: company.id,
      principalType: "agent",
      principalId: actorAgent.id,
      action: "tasks:assign",
      permissionKey: "tasks:assign",
      scope: { assigneeAgentId: targetAgent.id },
    });

    expect(decision).toMatchObject({
      allowed: true,
      grant: { permissionKey: "tasks:assign" },
    });
  });

  describeEmbeddedPostgres; // keep ref
  it("四季 restriction (flag ON): scopes non-privileged members to joined agents", async () => {
    process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY = "true";
    try {
      const company = await createCompany(db, "SeasonartsRestrict");
      const operatorId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: operatorId,
        status: "active", membershipRole: "operator",
      });
      const joinedAgent = await createAgent(db, company.id);
      const otherAgent = await createAgent(db, company.id);
      await db.insert(agentMemberships).values({
        companyId: company.id, agentId: joinedAgent.id, userId: operatorId, state: "joined",
      });
      const auth = authorizationService(db);
      const actor = { type: "board" as const, userId: operatorId, source: "session" as const };

      // joined agent → visible
      await expect(auth.decide({ actor, action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: joinedAgent.id } }))
        .resolves.toMatchObject({ allowed: true });
      // non-joined agent → HIDDEN (this is the 四季 restriction)
      await expect(auth.decide({ actor, action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: otherAgent.id } }))
        .resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
      // company-wide read → denied so per-item filtering kicks in
      await expect(auth.decide({ actor, action: "company_scope:read",
        resource: { type: "company", companyId: company.id } }))
        .resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    } finally {
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
    }
  });

  it("四季 restriction (flag OFF, default): non-privileged members keep upstream company-wide visibility", async () => {
    delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
    const company = await createCompany(db, "SeasonartsDefault");
    const operatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: operatorId,
      status: "active", membershipRole: "operator",
    });
    const otherAgent = await createAgent(db, company.id); // NOT joined
    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId: operatorId, source: "session" },
      action: "agent:read",
      resource: { type: "agent", companyId: company.id, agentId: otherAgent.id },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
  });

  it("四季 restriction (flag ON): owners/admins are unaffected — see all agents", async () => {
    process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY = "true";
    try {
      const company = await createCompany(db, "SeasonartsAdmin");
      const adminId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: adminId,
        status: "active", membershipRole: "admin",
      });
      const otherAgent = await createAgent(db, company.id); // NOT joined
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: adminId, source: "session" },
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: otherAgent.id },
      });
      expect(decision).toMatchObject({ allowed: true });
    } finally {
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
    }
  });



  // ============================================================
  // Phase 5: per-project privacy tests
  // ============================================================

  it("Phase5 (flag ON): private project is hidden from non-member operator", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_HideOperator");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Secret Project",
        issuePrefix: randomUUID().slice(0,6).toUpperCase(),
        visibility: "private",
      }).returning().then(r=>r[0]!);
      const operatorId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: operatorId,
        status: "active", membershipRole: "operator",
      });
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: operatorId, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(decision).toMatchObject({ allowed: false, reason: "deny_scope" });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag ON): explicit project member CAN see private project", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_ExplicitMember");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Members Only",
        issuePrefix: randomUUID().slice(0,6).toUpperCase(),
        visibility: "private",
      }).returning().then(r=>r[0]!);
      const userId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId,
        status: "active", membershipRole: "operator",
      });
      await db.insert(projectAccessMembers).values({
        companyId: company.id, projectId: project.id,
        principalType: "user", principalId: userId, projectRole: "editor",
      });
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(decision).toMatchObject({ allowed: true });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag ON): company admin always sees private project (no member needed)", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_AdminBypass");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Private",
        issuePrefix: randomUUID().slice(0,6).toUpperCase(),
        visibility: "private",
      }).returning().then(r=>r[0]!);
      const adminId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: adminId,
        status: "active", membershipRole: "admin",
      });
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: adminId, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(decision).toMatchObject({ allowed: true });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag ON): issue inside private project hidden from non-member", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_IssueHidden");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Secret",
        issuePrefix: randomUUID().slice(0,6).toUpperCase(),
        visibility: "private",
      }).returning().then(r=>r[0]!);
      const issue = await createIssue(db, company.id, { projectId: project.id });
      const operatorId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: operatorId,
        status: "active", membershipRole: "operator",
      });
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: operatorId, source: "session" },
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: issue.id, projectId: project.id },
      });
      expect(decision).toMatchObject({ allowed: false, reason: "deny_scope" });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag ON): team project visible to a user in the team, hidden otherwise", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_TeamScope");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Team Project",
        issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
        visibility: "team",
        team: "數位資訊部",
      }).returning().then((r) => r[0]!);

      // A user whose joined agent is tagged 數位資訊部 → in the team.
      const inUser = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: inUser,
        status: "active", membershipRole: "operator",
      });
      const inAgent = await db.insert(agents).values({
        companyId: company.id, name: `In ${randomUUID()}`, role: "engineer",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["數位資訊部"] },
      }).returning().then((r) => r[0]!);
      await db.insert(agentMemberships).values({ companyId: company.id, agentId: inAgent.id, userId: inUser, state: "joined" });

      // A user whose agent is in a different team → not in this project's team.
      const outUser = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: outUser,
        status: "active", membershipRole: "operator",
      });
      const outAgent = await db.insert(agents).values({
        companyId: company.id, name: `Out ${randomUUID()}`, role: "engineer",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["幼教學組"] },
      }).returning().then((r) => r[0]!);
      await db.insert(agentMemberships).values({ companyId: company.id, agentId: outAgent.id, userId: outUser, state: "joined" });

      const authz = authorizationService(db);
      const yes = await authz.decide({
        actor: { type: "board", userId: inUser, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(yes).toMatchObject({ allowed: true });

      const no = await authz.decide({
        actor: { type: "board", userId: outUser, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(no).toMatchObject({ allowed: false, reason: "deny_scope" });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag ON): multi-team project visible to a member of ANY listed team", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_MultiTeam");
      // teams array wins over the legacy single `team` label.
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Multi-Team Project",
        issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
        visibility: "team",
        team: "數位資訊部",
        teams: ["數位資訊部", "幼教學組"],
      }).returning().then((r) => r[0]!);

      // Member of the SECOND team → still allowed (any-of match).
      const inUser = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: inUser,
        status: "active", membershipRole: "operator",
      });
      const inAgent = await db.insert(agents).values({
        companyId: company.id, name: `In ${randomUUID()}`, role: "engineer",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["幼教學組"] },
      }).returning().then((r) => r[0]!);
      await db.insert(agentMemberships).values({ companyId: company.id, agentId: inAgent.id, userId: inUser, state: "joined" });

      // Member of a team NOT in the list → denied.
      const outUser = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: outUser,
        status: "active", membershipRole: "operator",
      });
      const outAgent = await db.insert(agents).values({
        companyId: company.id, name: `Out ${randomUUID()}`, role: "engineer",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["行政組"] },
      }).returning().then((r) => r[0]!);
      await db.insert(agentMemberships).values({ companyId: company.id, agentId: outAgent.id, userId: outUser, state: "joined" });

      const authz = authorizationService(db);
      const yes = await authz.decide({
        actor: { type: "board", userId: inUser, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(yes).toMatchObject({ allowed: true });

      const no = await authz.decide({
        actor: { type: "board", userId: outUser, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(no).toMatchObject({ allowed: false, reason: "deny_scope" });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase2 (flag ON): agent NOT in a team project's team is denied issue:read; assignee agent keeps access", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P2_AgentTeamScope");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Team Project (agent)",
        issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
        visibility: "team",
        teams: ["數位資訊部"],
      }).returning().then((r) => r[0]!);

      const inAgent = await db.insert(agents).values({
        companyId: company.id, name: `In ${randomUUID()}`, role: "engineer", status: "active",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["數位資訊部"] },
      }).returning().then((r) => r[0]!);
      const outAgent = await db.insert(agents).values({
        companyId: company.id, name: `Out ${randomUUID()}`, role: "engineer", status: "active",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        metadata: { teams: ["幼教學組"] },
      }).returning().then((r) => r[0]!);
      for (const a of [inAgent, outAgent]) {
        await db.insert(companyMemberships).values({
          companyId: company.id, principalType: "agent", principalId: a.id,
          status: "active", membershipRole: "member",
        });
      }

      const authz = authorizationService(db);
      const issueResource = (assigneeAgentId: string | null) => ({
        type: "issue" as const, companyId: company.id, issueId: randomUUID(),
        projectId: project.id, assigneeAgentId,
      });

      // Out-of-team agent, not assigned → denied.
      const denied = await authz.decide({
        actor: { type: "agent", agentId: outAgent.id, companyId: company.id, source: "agent_key" },
        action: "issue:read",
        resource: issueResource(null),
      });
      expect(denied).toMatchObject({ allowed: false, reason: "deny_scope" });

      // In-team agent → allowed.
      const allowedTeam = await authz.decide({
        actor: { type: "agent", agentId: inAgent.id, companyId: company.id, source: "agent_key" },
        action: "issue:read",
        resource: issueResource(null),
      });
      expect(allowedTeam).toMatchObject({ allowed: true });

      // Out-of-team agent but ASSIGNED to the issue → keeps access.
      const allowedAssignee = await authz.decide({
        actor: { type: "agent", agentId: outAgent.id, companyId: company.id, source: "agent_key" },
        action: "issue:read",
        resource: issueResource(outAgent.id),
      });
      expect(allowedAssignee).toMatchObject({ allowed: true });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase2 (flag OFF, default): agent keeps company-wide issue:read regardless of project scope", async () => {
    const company = await createCompany(db, "P2_AgentFlagOff");
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: "Team Project (flag off)",
      issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
      visibility: "team",
      teams: ["數位資訊部"],
    }).returning().then((r) => r[0]!);
    const outAgent = await db.insert(agents).values({
      companyId: company.id, name: `Out ${randomUUID()}`, role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      metadata: { teams: ["幼教學組"] },
    }).returning().then((r) => r[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "agent", principalId: outAgent.id,
      status: "active", membershipRole: "member",
    });
    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: outAgent.id, companyId: company.id, source: "agent_key" },
      action: "issue:read",
      resource: { type: "issue", companyId: company.id, issueId: randomUUID(), projectId: project.id, assigneeAgentId: null },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_company_agent" });
  });

  it("Phase5 (flag ON): company-wide project (visibility=company) unaffected — member can read", async () => {
    process.env.PAPERCLIP_PROJECT_PRIVACY = "true";
    try {
      const company = await createCompany(db, "P5_CompanyWide");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Public",
        issuePrefix: randomUUID().slice(0,6).toUpperCase(),
        visibility: "company",
      }).returning().then(r=>r[0]!);
      const operatorId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: operatorId,
        status: "active", membershipRole: "operator",
      });
      const decision = await authorizationService(db).decide({
        actor: { type: "board", userId: operatorId, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(decision).toMatchObject({ allowed: true });
    } finally { delete process.env.PAPERCLIP_PROJECT_PRIVACY; }
  });

  it("Phase5 (flag OFF, default): private project STILL visible to all members (flag protects)", async () => {
    delete process.env.PAPERCLIP_PROJECT_PRIVACY;
    const company = await createCompany(db, "P5_FlagOff");
    const project = await db.insert(projects).values({
      companyId: company.id,
      name: "Would-be-private",
      issuePrefix: randomUUID().slice(0,6).toUpperCase(),
      visibility: "private",
    }).returning().then(r=>r[0]!);
    const operatorId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: operatorId,
      status: "active", membershipRole: "operator",
    });
    const decision = await authorizationService(db).decide({
      actor: { type: "board", userId: operatorId, source: "session" },
      action: "project:read",
      resource: { type: "project", companyId: company.id, projectId: project.id },
    });
    // flag OFF → falls through to standard allow
    expect(decision).toMatchObject({ allowed: true });
  });

  it("Visibility flag ONLY: hides private projects from non-members, but leaves tasks + agents unscoped", async () => {
    delete process.env.PAPERCLIP_PROJECT_PRIVACY;
    process.env.PAPERCLIP_PROJECT_VISIBILITY = "true";
    try {
      const company = await createCompany(db, "P5_VisOnly");
      const project = await db.insert(projects).values({
        companyId: company.id,
        name: "Private (vis-only)",
        issuePrefix: randomUUID().slice(0, 6).toUpperCase(),
        visibility: "private",
      }).returning().then((r) => r[0]!);
      const outUser = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: outUser,
        status: "active", membershipRole: "operator",
      });
      const agent = await db.insert(agents).values({
        companyId: company.id, name: `A ${randomUUID()}`, role: "engineer", status: "active",
        adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      }).returning().then((r) => r[0]!);
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "agent", principalId: agent.id,
        status: "active", membershipRole: "member",
      });
      const authz = authorizationService(db);

      // Non-member human: PROJECT hidden (deny), but its TASK still readable (task not scoped).
      const projRead = await authz.decide({
        actor: { type: "board", userId: outUser, source: "session" },
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      });
      expect(projRead).toMatchObject({ allowed: false, reason: "deny_scope" });

      const issueRead = await authz.decide({
        actor: { type: "board", userId: outUser, source: "session" },
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: randomUUID(), projectId: project.id, assigneeAgentId: null },
      });
      expect(issueRead).toMatchObject({ allowed: true });

      // Agent: unaffected under the visibility-only flag (needs the full privacy flag).
      const agentIssueRead = await authz.decide({
        actor: { type: "agent", agentId: agent.id, companyId: company.id, source: "agent_key" },
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: randomUUID(), projectId: project.id, assigneeAgentId: null },
      });
      expect(agentIssueRead).toMatchObject({ allowed: true, reason: "allow_company_agent" });
    } finally { delete process.env.PAPERCLIP_PROJECT_VISIBILITY; }
  });

  it("scopes task bridge keys away from company-wide reads and unrelated issue writes", async () => {
    const company = await createCompany(db, "TaskBridge");
    const bridgeAgent = await createAgent(db, company.id);
    const targetAgent = await createAgent(db, company.id);
    const project = await createProject(db, company.id, "Bridge");
    const parentIssue = await createIssue(db, company.id, { projectId: project.id });
    const assignedIssue = await createIssue(db, company.id, { assigneeAgentId: bridgeAgent.id });
    const keyId = randomUUID();
    const bridgeCreatedIssue = await createIssue(db, company.id, {
      originKind: "task_bridge",
      originId: keyId,
    });
    const unrelatedIssue = await createIssue(db, company.id);
    const actor = {
      type: "agent" as const,
      agentId: bridgeAgent.id,
      companyId: company.id,
      source: "agent_key" as const,
      keyId,
      keyScope: {
        kind: "task_bridge" as const,
        parentIssueId: parentIssue.id,
        allowedAssigneeAgentIds: [targetAgent.id],
      },
    };
    const authz = authorizationService(db);

    await expect(authz.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        parentIssueId: parentIssue.id,
        assigneeAgentId: targetAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        projectId: project.id,
        assigneeUserId: randomUUID(),
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "issue:comment",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: assignedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: bridgeCreatedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: true,
    });

    await expect(authz.decide({
      actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: unrelatedIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: company.id,
        agentId: bridgeAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });

  it("scopes skill-test keys to their own issue only", async () => {
    const company = await createCompany(db, "SkillTest");
    const skillTestAgent = await createAgent(db, company.id);
    const ownIssue = await createIssue(db, company.id, { assigneeAgentId: skillTestAgent.id });
    const otherIssue = await createIssue(db, company.id);
    const actor = {
      type: "agent" as const,
      agentId: skillTestAgent.id,
      companyId: company.id,
      source: "agent_key" as const,
      keyScope: {
        kind: "skill_test" as const,
        issueId: ownIssue.id,
      },
    };
    const authz = authorizationService(db);

    for (const action of ["issue:read", "issue:comment", "issue:mutate"] as const) {
      await expect(authz.decide({
        actor,
        action,
        resource: {
          type: "issue",
          companyId: company.id,
          issueId: ownIssue.id,
        },
      })).resolves.toMatchObject({
        allowed: true,
      });
    }

    await expect(authz.decide({
      actor,
      action: "issue:mutate",
      resource: {
        type: "issue",
        companyId: company.id,
        issueId: otherIssue.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });

    await expect(authz.decide({
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: company.id,
        parentIssueId: ownIssue.id,
        assigneeAgentId: skillTestAgent.id,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_scope",
    });
  });

  it("allows responsible-user inbox management by default", async () => {
    const company = await createCompany(db, "InboxDefaultOpen");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({
      allowed: true,
      reason: "allow_self",
      inboxPolicyMode: "open",
    });
  });

  it("denies responsible-user inbox management when disabled", async () => {
    const company = await createCompany(db, "InboxDisabled");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(userInboxAgentPolicies).values({
      companyId: company.id,
      userId: responsibleUserId,
      mode: "disabled",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "inbox_management_disabled" });
  });

  it("enforces responsible-user inbox allowlists", async () => {
    const company = await createCompany(db, "InboxAllowlist");
    const allowedAgent = await createAgent(db, company.id);
    const deniedAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(userInboxAgentPolicies).values({
      companyId: company.id,
      userId: responsibleUserId,
      mode: "allowlist",
      allowedAgentIds: [allowedAgent.id],
    });
    const decideFor = (agentId: string) => authorizationService(db).decide({
      actor: {
        type: "agent" as const,
        agentId,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt" as const,
      },
      action: "inbox:manage" as const,
      resource: { type: "company" as const, companyId: company.id },
    });

    await expect(decideFor(allowedAgent.id)).resolves.toMatchObject({
      allowed: true,
      reason: "allow_self",
      inboxPolicyMode: "allowlist",
    });
    await expect(decideFor(deniedAgent.id)).resolves.toMatchObject({
      allowed: false,
      reason: "inbox_agent_not_allowed",
    });
  });

  it("requires a grant for cross-user inbox management", async () => {
    const company = await createCompany(db, "InboxCrossUserDenied");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    const targetUserId = await createUser(db);
    await db.insert(companyMemberships).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: targetUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
      scope: { userId: targetUserId },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_missing_grant" });
  });

  it("allows cross-user inbox management with an unscoped grant", async () => {
    const company = await createCompany(db, "InboxCrossUserGranted");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    const targetUserId = await createUser(db);
    await db.insert(companyMemberships).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: targetUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await grantAgentPermission(db, company.id, actorAgent.id, "inbox:manage");

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
      scope: { userId: targetUserId },
    })).resolves.toMatchObject({ allowed: true, reason: "allow_explicit_grant" });
  });

  it("enforces user-scoped cross-user inbox grants", async () => {
    const company = await createCompany(db, "InboxCrossUserScoped");
    const actorAgent = await createAgent(db, company.id);
    const responsibleUserId = await createUser(db);
    const allowedTargetUserId = await createUser(db);
    const deniedTargetUserId = await createUser(db);
    await db.insert(companyMemberships).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: allowedTargetUserId,
        status: "active",
        membershipRole: "operator",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: deniedTargetUserId,
        status: "active",
        membershipRole: "operator",
      },
    ]);
    await grantAgentPermission(db, company.id, actorAgent.id, "inbox:manage", {
      userIds: [allowedTargetUserId],
    });
    const decideFor = (userId: string) => authorizationService(db).decide({
      actor: {
        type: "agent" as const,
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt" as const,
      },
      action: "inbox:manage" as const,
      resource: { type: "company" as const, companyId: company.id },
      scope: { userId },
    });

    await expect(decideFor(allowedTargetUserId)).resolves.toMatchObject({
      allowed: true,
      reason: "allow_explicit_grant",
    });
    await expect(decideFor(deniedTargetUserId)).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
  });

  it("denies inbox management when the target user cannot be resolved", async () => {
    const company = await createCompany(db, "InboxUnresolved");
    const actorAgent = await createAgent(db, company.id);

    await expect(authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source: "agent_key" },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "inbox_target_user_unresolved" });
  });

  it("denies low-trust inbox management", async () => {
    const company = await createCompany(db, "InboxLowTrust");
    const project = await createProject(db, company.id, "InboxLowTrust");
    const responsibleUserId = await createUser(db);
    const actorAgent = await createAgent(db, company.id, {
      permissions: {
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: company.id,
            projectIds: [project.id],
          },
        },
      },
    });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "operator",
    });

    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId: actorAgent.id,
        companyId: company.id,
        onBehalfOfUserId: responsibleUserId,
        source: "agent_jwt",
      },
      action: "inbox:manage",
      resource: { type: "company", companyId: company.id },
    })).resolves.toMatchObject({ allowed: false, reason: "deny_low_trust_boundary" });
  });

  /**
   * The restriction used to be an opt-in denylist.
   *
   * `restrictedMemberCanRead` returned `boolean | null`, and `null` meant "fall
   * through to the standard membership rule" — which allows any active member.
   * So a restricted member was denied only what somebody had remembered to
   * deny, and every action added to the gate afterwards defaulted to
   * company-wide. Three had accumulated by the time it was found, the worst
   * being `secrets:read`, which resolves actual secret VALUES.
   *
   * These cases pin the inversion. They are written per action rather than as
   * one loop because each one is a separate product decision, and a loop would
   * let a future change quietly flip one without anybody reading a diff.
   */
  describe("四季 restriction (flag ON): actions default to denied", () => {
    async function restrictedMember(label: string) {
      process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY = "true";
      const company = await createCompany(db, label);
      const userId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId,
        status: "active", membershipRole: "operator",
      });
      const joinedAgent = await createAgent(db, company.id);
      await db.insert(agentMemberships).values({
        companyId: company.id, agentId: joinedAgent.id, userId, state: "joined",
      });
      return {
        company,
        userId,
        joinedAgent,
        auth: authorizationService(db),
        actor: { type: "board" as const, userId, source: "session" as const },
      };
    }

    afterEach(() => {
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
    });

    /**
     * The one that matters most. A shared credential is the opposite of "you
     * see your own corner of the company", and a leaked secret is not
     * recoverable the way a leaked task title is.
     */
    it("refuses secrets:read", async () => {
      const { auth, actor, company } = await restrictedMember("RestrictSecrets");

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "company", companyId: company.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("refuses company-wide runtime:manage", async () => {
      const { auth, actor, company } = await restrictedMember("RestrictRuntime");

      await expect(auth.decide({
        actor,
        action: "runtime:manage",
        resource: { type: "company", companyId: company.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    /**
     * Project reads are SCOPED, not denied. A blanket denial would empty the
     * sidebar for exactly the people the restriction is meant to leave working
     * normally, and a security change that makes the product unusable gets
     * switched off — which protects nobody.
     */
    it("hides a project the member has no work in", async () => {
      const { auth, actor, company } = await restrictedMember("RestrictProjectHidden");
      const project = await createProject(db, company.id, "hidden");

      await expect(auth.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("shows a project the member's own agent has work in", async () => {
      const { auth, actor, company, joinedAgent } = await restrictedMember("RestrictProjectVisible");
      const project = await createProject(db, company.id, "visible");
      await createIssue(db, company.id, { projectId: project.id, assigneeAgentId: joinedAgent.id });

      await expect(auth.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    it("shows a project the member owns even with no tasks in it", async () => {
      const { auth, actor, company, userId } = await restrictedMember("RestrictProjectOwned");
      const project = await createProject(db, company.id, "owned");
      await db.update(projects).set({ ownerUserId: userId }).where(eq(projects.id, project.id));

      await expect(auth.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: project.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    // Asking "may I read projects at all" is not asking about one project; the
    // per-item filter is what narrows the list. Answering no here would close
    // the page rather than scope it.
    it("allows a project-less read so the list can filter per item", async () => {
      const { auth, actor, company } = await restrictedMember("RestrictProjectGeneric");

      await expect(auth.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId: company.id, projectId: null },
      })).resolves.toMatchObject({ allowed: true });
    });

    // Privileged roles never reach the restricted path at all — worth pinning,
    // because a mistake here locks out the people who administer the company.
    it("leaves an admin's secrets:read untouched", async () => {
      process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY = "true";
      const company = await createCompany(db, "RestrictAdminSecrets");
      const adminId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: adminId,
        status: "active", membershipRole: "admin",
      });

      await expect(authorizationService(db).decide({
        actor: { type: "board", userId: adminId, source: "session" },
        action: "secrets:read",
        resource: { type: "company", companyId: company.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    // With the flag off nobody is restricted, and this whole path is inert.
    it("changes nothing when the flag is off", async () => {
      const company = await createCompany(db, "RestrictFlagOffSecrets");
      const userId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId,
        status: "active", membershipRole: "operator",
      });
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;

      await expect(authorizationService(db).decide({
        actor: { type: "board", userId, source: "session" },
        action: "secrets:read",
        resource: { type: "company", companyId: company.id },
      })).resolves.toMatchObject({ allowed: true, reason: "allow_simple_company_member" });
    });
  });

  /**
   * The restriction applied to AGENT actors.
   *
   * The same hole as the human one and wider, because agents are what actually
   * make the API calls in bulk: a member's personal assistant could read every
   * other person's tasks and every project in the company.
   *
   * Half of these cases assert that something is NOT restricted. That is the
   * important half — scoping an infrastructure agent to an empty set would break
   * the automation everyone depends on, and it is the failure that would look
   * like "the platform is broken" rather than "authorization is strict".
   */
  describe("四季 restriction (flag ON): agent actors are scoped to their mapped user", () => {
    afterEach(() => {
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;
    });

    async function scenario(label: string, opts: { membershipRole?: string; mapped?: boolean } = {}) {
      process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY = "true";
      const company = await createCompany(db, label);
      const userId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({
        companyId: company.id, principalType: "user", principalId: userId,
        status: "active", membershipRole: opts.membershipRole ?? "operator",
      });
      const ownAgent = await createAgent(db, company.id);
      const strangerAgent = await createAgent(db, company.id);
      if (opts.mapped !== false) {
        await db.insert(agentMemberships).values({
          companyId: company.id, agentId: ownAgent.id, userId, state: "joined",
        });
      }
      return {
        company,
        userId,
        ownAgent,
        strangerAgent,
        auth: authorizationService(db),
        actor: {
          type: "agent" as const,
          agentId: ownAgent.id,
          companyId: company.id,
          source: "agent_key" as const,
        },
      };
    }

    it("hides another person's agent from a restricted member's agent", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentScopeHidden");

      await expect(auth.decide({
        actor,
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: strangerAgent.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("still lets it read itself", async () => {
      const { auth, actor, company, ownAgent } = await scenario("AgentScopeSelf");

      await expect(auth.decide({
        actor,
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: ownAgent.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    it("hides a task belonging to nobody it works for", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentScopeIssue");
      const strangersIssue = await createIssue(db, company.id, { assigneeAgentId: strangerAgent.id });

      await expect(auth.decide({
        actor,
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: strangersIssue.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("still shows a task assigned to itself", async () => {
      const { auth, actor, company, ownAgent } = await scenario("AgentScopeOwnIssue");
      const ownIssue = await createIssue(db, company.id, { assigneeAgentId: ownAgent.id });

      await expect(auth.decide({
        actor,
        action: "issue:read",
        resource: { type: "issue", companyId: company.id, issueId: ownIssue.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    /**
     * Infrastructure agents (系統自動化, built-ins) map to nobody. There is no
     * person's world to scope them to, and scoping them to an empty set would
     * silently break every automation on the platform.
     */
    it("leaves an agent that maps to nobody company-wide", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentScopeUnmapped", { mapped: false });

      await expect(auth.decide({
        actor,
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: strangerAgent.id },
      })).resolves.toMatchObject({ allowed: true, reason: "allow_company_agent" });
    });

    // Narrowing an admin's agent below the admin's own reach would be incoherent.
    it("leaves a privileged user's agent company-wide", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentScopeAdmin", { membershipRole: "admin" });

      await expect(auth.decide({
        actor,
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: strangerAgent.id },
      })).resolves.toMatchObject({ allowed: true, reason: "allow_company_agent" });
    });

    /**
     * Deliberately still company-wide, and this test exists so the decision is
     * recorded rather than looking like an omission. An agent resolves its own
     * bound secrets during a normal run, so denying this wholesale would break
     * every restricted member's agent. It needs a per-secret decision first.
     */
    /**
     * Per-secret, not per-company.
     *
     * The first cut denied `secrets:read` outright for restricted members. Safe,
     * and wrong in a way that would have surfaced as "the platform is broken":
     * a shared credential is not theirs, but the token bound to their OWN agent
     * plainly is — it is how that agent talks to Asana for them.
     *
     * Safe to narrow for agents because the run-time path already required a
     * binding row before handing over a value, so "bound to an agent this user
     * can see" is a superset of what it already permitted.
     */
    async function secretBoundTo(companyId: string, target: { type: "agent" | "project"; id: string }) {
      const [secret] = await db
        .insert(companySecrets)
        .values({
          companyId,
          key: `KEY_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          name: `secret-${randomUUID()}`,
        })
        .returning();
      await db.insert(companySecretBindings).values({
        companyId,
        secretId: secret!.id,
        targetType: target.type,
        targetId: target.id,
        configPath: "env.SOME_TOKEN",
      });
      return secret!;
    }

    it("lets an agent read a secret bound to itself", async () => {
      const { auth, actor, company, ownAgent } = await scenario("AgentSecretOwn");
      const secret = await secretBoundTo(company.id, { type: "agent", id: ownAgent.id });

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id, secretId: secret.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    // The whole point: a credential in somebody else's corner of the company.
    it("refuses a secret bound to an agent it cannot see", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentSecretStranger");
      const secret = await secretBoundTo(company.id, { type: "agent", id: strangerAgent.id });

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id, secretId: secret.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    // A company-wide shared credential is bound to nobody in their scope.
    it("refuses an unbound secret", async () => {
      const { auth, actor, company } = await scenario("AgentSecretUnbound");
      const [secret] = await db
        .insert(companySecrets)
        .values({ companyId: company.id, key: "SHARED_KEY", name: "shared" })
        .returning();

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id, secretId: secret!.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    /**
     * Listing one agent's own bindings. The caller filters to that agent itself,
     * so there is no single secret to name — refusing this would stop an agent
     * enumerating its own secrets, which is a legitimate thing to do.
     */
    it("lets an agent enumerate its own secrets without naming one", async () => {
      const { auth, actor, company, ownAgent } = await scenario("AgentSecretList");

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id, targetAgentId: ownAgent.id },
      })).resolves.toMatchObject({ allowed: true });
    });

    it("refuses enumerating another agent's secrets", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentSecretListOther");

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id, targetAgentId: strangerAgent.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    // "May I read secrets in general" has no per-secret answer, and for someone
    // scoped to their own corner the honest response is no.
    it("refuses a request that names neither a secret nor an agent", async () => {
      const { auth, actor, company } = await scenario("AgentSecretUnnamed");

      await expect(auth.decide({
        actor,
        action: "secrets:read",
        resource: { type: "secret", companyId: company.id },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_scope" });
    });

    it("changes nothing for agents when the flag is off", async () => {
      const { auth, actor, company, strangerAgent } = await scenario("AgentScopeFlagOff");
      delete process.env.PAPERCLIP_RESTRICT_AGENT_VISIBILITY;

      await expect(auth.decide({
        actor,
        action: "agent:read",
        resource: { type: "agent", companyId: company.id, agentId: strangerAgent.id },
      })).resolves.toMatchObject({ allowed: true, reason: "allow_company_agent" });
    });
  });

});
