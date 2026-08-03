import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  normalizeIssueIdentifier,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  companyService,
  agentService,
  issueService,
  heartbeatService,
  accessService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { fetchRuntimeAccounts, setRuntimeAccountPin } from "../services/runtime-accounts.js";
import {
  mayViewRuntimeAccounts,
  runtimeAccountViewerReason,
} from "../services/runtime-account-visibility.js";
import { forbidden } from "../errors.js";
import { badRequest } from "../errors.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

export function parseCostDateRange(query: Record<string, unknown>) {
  const fromRaw = query.from as string | undefined;
  const toRaw = query.to as string | undefined;
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
  if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
  return (from || to) ? { from, to } : undefined;
}

export function parseCostLimit(query: Record<string, unknown>) {
  const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  if (raw == null || raw === "") return 100;
  const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
    throw badRequest("invalid 'limit' value");
  }
  return limit;
}

export function costRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const router = Router();
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const companies = companyService(db);
  const agents = agentService(db);
  const issues = issueService(db);
  const access = accessService(db);

  async function resolveIssueByRef(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) {
      return issues.getByIdentifier(identifier);
    }
    return issues.getById(rawId);
  }

  async function assertCompanyCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Costs are outside this actor's authorization boundary" });
    return false;
  }

  async function assertIssueCostReadAllowed(req: Parameters<typeof assertCompanyAccess>[0], res: any, issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    status: string;
  }) {
    const decision = await access.decide({
      actor: req.actor,
      action: "issue:read",
      resource: {
        type: "issue",
        companyId: issue.companyId,
        issueId: issue.id,
        projectId: issue.projectId,
        parentIssueId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        status: issue.status,
      },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Issue costs are outside this actor's authorization boundary" });
    return false;
  }

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/companies/:companyId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const event = await finance.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/issues/:id/cost-summary", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, resolveIssueByRef(rawId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueCostReadAllowed(req, res, issue))) return;
    const excludeRoot = req.query.excludeRoot === "true" || req.query.excludeRoot === "1";
    const summary = await costs.issueTreeSummary(issue.companyId, issue.id, { excludeRoot });
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-agent-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byAgentModel(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-provider", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProvider(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/finance-by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/finance-events", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const limit = parseCostLimit(req.query);
    const rows = await finance.list(companyId, range, limit);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/window-spend", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const rows = await costs.windowSpend(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/quota-windows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // validate companyId resolves to a real company so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  // Which provider account the platform is running on right now. Read-only, and
  // visible to a narrower audience than the quota windows above: the account
  // EMAIL is personally identifying, so it is gated to the admin tier, 資訊部,
  // and explicit runtime:view_accounts holders rather than every company member.
  router.get("/companies/:companyId/costs/runtime-accounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const isInstanceAdmin = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
    const userId = req.actor.userId ?? null;
    const [membership, email, hasExplicitGrant] = await Promise.all([
      userId ? access.getMembership(companyId, "user", userId) : Promise.resolve(null),
      userId ? access.getUserEmail(userId) : Promise.resolve(null),
      userId
        ? access.hasPermission(companyId, "user", userId, "runtime:view_accounts")
        : Promise.resolve(false),
    ]);
    const viewer = {
      isInstanceAdmin,
      membershipRole: membership?.membershipRole ?? null,
      email,
      hasExplicitGrant,
    };
    if (!mayViewRuntimeAccounts(viewer)) {
      throw forbidden("Missing permission: runtime:view_accounts");
    }

    const viewerReason = runtimeAccountViewerReason(viewer);
    const results = await fetchRuntimeAccounts(db, companyId);
    res.json(results.map((result) => ({ ...result, viewerReason, canSwitch: true })));
  });

  // Pin runs to one pooled account, or clear the pin to return to automatic
  // rotation. Same audience as reading the accounts, per the operator request:
  // whoever can see which account is in use can also choose it. The pin is a
  // preference, not an override — a quota-limited pin is still rotated past so
  // agents keep working, and is resumed when its window resets.
  router.post("/companies/:companyId/costs/runtime-accounts/pin", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const isInstanceAdmin = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
    const userId = req.actor.userId ?? null;
    const [membership, email, hasExplicitGrant] = await Promise.all([
      userId ? access.getMembership(companyId, "user", userId) : Promise.resolve(null),
      userId ? access.getUserEmail(userId) : Promise.resolve(null),
      userId
        ? access.hasPermission(companyId, "user", userId, "runtime:view_accounts")
        : Promise.resolve(false),
    ]);
    const viewer = {
      isInstanceAdmin,
      membershipRole: membership?.membershipRole ?? null,
      email,
      hasExplicitGrant,
    };
    if (!mayViewRuntimeAccounts(viewer)) {
      throw forbidden("Missing permission: runtime:view_accounts");
    }

    const rawDir = req.body?.dir;
    if (rawDir != null && typeof rawDir !== "string") {
      throw badRequest("dir must be a string path, or null to clear the pin");
    }
    const requested = typeof rawDir === "string" ? rawDir.trim() : "";

    const outcome = await setRuntimeAccountPin(db, companyId, requested || null);
    if (outcome.kind === "unknown_dir") {
      throw badRequest(
        `${requested} is not one of this company's configured Claude accounts`,
      );
    }
    if (outcome.kind === "unsupported") {
      throw badRequest("No adapter on this instance supports account pinning");
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: requested ? "runtime_account.pinned" : "runtime_account.pin_cleared",
      entityType: "runtime_account",
      // The pool is the entity; a cleared pin still names it.
      entityId: requested || "pool",
      details: {
        dir: requested || null,
        viewerReason: runtimeAccountViewerReason(viewer),
        persisted: outcome.persisted,
      },
    });

    const viewerReason = runtimeAccountViewerReason(viewer);
    const results = await fetchRuntimeAccounts(db, companyId);
    res.json(results.map((result) => ({ ...result, viewerReason, canSwitch: true })));
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const overview = await budgets.overview(companyId);
    res.json(overview);
  });

  router.post(
    "/companies/:companyId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const summary = await budgets.upsertPolicy(companyId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.post(
    "/companies/:companyId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, companyId);
      const incident = await budgets.resolveIncident(companyId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyCostReadAllowed(req, res, companyId))) return;
    const range = parseCostDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      companyId,
      {
        scopeType: "company",
        scopeId: companyId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await getAccessibleResource(req, res, agents.getById(agentId), "Agent not found");
    if (!agent) return;

    assertBoard(req);

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      updated.companyId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    );

    res.json(updated);
  });

  return router;
}
