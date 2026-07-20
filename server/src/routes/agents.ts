import { Router, type Request, type Response } from "express";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agentMemberships, agents as agentsTable, authUsers, companies, heartbeatRuns, issues as issuesTable, projects as projectsTable } from "@paperclipai/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentMineInboxQuerySchema,
  ADAPTER_AGNOSTIC_KEYS,
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  normalizeIssueIdentifier,
  resetAgentSessionSchema,
  testAdapterEnvironmentSchema,
  type AgentDesiredSkillEntry,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
  supportedEnvironmentDriversForAdapter,
  LOW_TRUST_REVIEW_PRESET,
} from "@paperclipai/shared";
import {
  resolvePaperclipInstanceRootForAdapter,
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { trackAgentCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  builtInAgentService,
  companySkillService,
  budgetService,
  heartbeatService,
  ISSUE_LIST_DEFAULT_LIMIT,
  issueApprovalService,
  issueRecoveryActionService,
  issueService,
  logActivity,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getAccessibleResource, getActorInfo, getVisibleAgentIds, getJoinedAgentIds, hasCompanyAccess } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentService } from "../services/environments.js";
import { notificationService } from "../services/notifications.js";
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { skillVersionSelectionMap } from "../services/runtime-skill-selections.js";
import { secretService } from "../services/secrets.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import {
  detectAdapterModel,
  findActiveServerAdapter,
  findServerAdapter,
  listAdapterModels,
  listAdapterModelProfiles,
  refreshAdapterModels,
  requireServerAdapter,
} from "../adapters/index.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import {
  instanceSettingsService,
  isTruthyRuntimeEnvValue,
  resolveWorktreeRunExecutionActivationState,
} from "../services/instance-settings.js";
import { runClaudeLogin } from "@paperclipai/adapter-claude-local/server";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { requireOpenCodeModelId } from "@paperclipai/adapter-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";
import { getTelemetryClient } from "../telemetry.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { recoveryService } from "../services/recovery/service.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";
import { readObject } from "../lib/objects.js";
import { listInvalidOrgChainDescendantIds } from "../services/agent-invokability.js";
import {
  AGENT_PROFILE_CHANGE_CONSENT_FIELDS,
  agentInstructionsChangeTargetKey,
  agentProfileChangeTargetKey,
  changeConsentGateService,
  touchesAgentProfileChangeConsentFields,
} from "../services/change-consent-gate.js";

const RUN_LOG_DEFAULT_LIMIT_BYTES = 256_000;
const RUN_LOG_MAX_LIMIT_BYTES = 1024 * 1024;

function readRunLogLimitBytes(value: unknown) {
  const parsed = Number(value ?? RUN_LOG_DEFAULT_LIMIT_BYTES);
  if (!Number.isFinite(parsed)) return RUN_LOG_DEFAULT_LIMIT_BYTES;
  return Math.max(1, Math.min(RUN_LOG_MAX_LIMIT_BYTES, Math.trunc(parsed)));
}

function readLiveRunsQueryInt(value: unknown, max: number, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(max, Math.trunc(parsed));
}

function readRunIssueId(context: Record<string, unknown> | null) {
  const directIssueId = context?.issueId;
  if (typeof directIssueId === "string" && isUuidLike(directIssueId)) return directIssueId;
  const paperclipIssue = readObject(context?.paperclipIssue);
  const nestedIssueId = paperclipIssue?.id;
  return typeof nestedIssueId === "string" && isUuidLike(nestedIssueId) ? nestedIssueId : null;
}

export function agentRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    /** When true, non-privileged users (operator/viewer) see ONLY the agents
     *  they've joined (agent_memberships). Off by default so the platform keeps
     *  its standard behaviour (company members see all agents, redacted). The
     *  四季 single-company deployment turns this on for strict per-user isolation. */
    restrictAgentVisibility?: boolean;
  } = {},
) {
  const restrictAgentVisibility = options.restrictAgentVisibility ?? false;
  // Legacy hardcoded maps — used as fallback when adapter module does not
  // declare capability flags explicitly.
  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    droid_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));

  /** Check if an adapter supports the managed instructions bundle. */
  function adapterSupportsInstructionsBundle(adapterType: string): boolean {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
    return DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
  }

  /** Resolve the adapter config key for the instructions file path. */
  function resolveInstructionsPathKey(adapterType: string): string | null {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.instructionsPathKey) return adapter.instructionsPathKey;
    if (adapter?.supportsInstructionsBundle === true) return "instructionsFilePath";
    if (adapter?.supportsInstructionsBundle === false) return null;
    return DEFAULT_INSTRUCTIONS_PATH_KEYS[adapterType] ?? null;
  }
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;
  const KNOWN_INSTRUCTIONS_BUNDLE_KEY_SET: ReadonlySet<string> = new Set(KNOWN_INSTRUCTIONS_BUNDLE_KEYS);

  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const budgets = budgetService(db);
  const environmentsSvc = environmentService(db);
  const environmentRuntime = environmentRuntimeService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const instructions = agentInstructionsService();
  const companySkills = companySkillService(db);
  const notifications = notificationService(db);
  // Ranks that may distribute skills to ANYONE (incl. upward) without the
  // recipient's approval — the recipient just gets a notification. Covers
  // 副理/經理 及以上 and 副園長/園長/總園長, plus the founder and Jay (board owner).
  // Matched against the agent's name + title, so a new 副理/園長 auto-qualifies.
  const PRIVILEGED_DISTRIBUTOR_KEYWORDS = [
    "園長", "副理", "經理", "協理", "總監", "副總", "執行長", "董事長", "創辦人", "Founder",
  ];
  const isPrivilegedDistributor = (a: { name?: string | null; title?: string | null }): boolean => {
    const hay = `${a.name ?? ""} ${a.title ?? ""}`;
    return PRIVILEGED_DISTRIBUTOR_KEYWORDS.some((k) => hay.includes(k));
  };
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function assertAgentEnvironmentSelection(
    companyId: string,
    adapterType: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentService(db), companyId, environmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(adapterType),
    });
  }

  async function decideAgentRead(req: Request, agent: { id: string; companyId: string }) {
    return access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
  }

  async function assertAgentReadAllowed(req: Request, res: Response, agent: { id: string; companyId: string }) {
    const decision = await decideAgentRead(req, agent);
    if (decision.allowed) return true;
    res.status(403).json({ error: "Agent is outside this actor's authorization boundary" });
    return false;
  }

  async function filterAgentsForActor<T extends Record<string, unknown>>(
    req: Request,
    rows: T[],
    fallbackCompanyId?: string,
  ) {
    const decisions = await Promise.all(rows.map((agent) => {
      const id = typeof agent.id === "string" ? agent.id : null;
      const companyId = typeof agent.companyId === "string" ? agent.companyId : fallbackCompanyId ?? null;
      if (!id || !companyId) return Promise.resolve({ allowed: false });
      return decideAgentRead(req, { id, companyId });
    }));
    return rows.filter((_, index) => decisions[index]?.allowed);
  }

  /**
   * Resolve the execution target the adapter should run its test probes against.
   *
   * - No environmentId / local environment → returns a local target so the
   *   adapter probes the Paperclip host (legacy behavior).
   * - SSH environment → builds an SSH execution target from the environment
   *   config so the adapter probes the remote box. No lease is required:
   *   the SSH spec is fully derived from the saved environment config.
   * - Sandbox / plugin environments → acquires an ad-hoc lease, realizes the
   *   workspace, and resolves a sandbox execution target wired to the runtime
   *   so the adapter probe runs inside the sandbox the same way a heartbeat
   *   would. The returned `release` callback rolls the lease back when the
   *   route is done.
   *
   * The caller MUST always invoke `release()` (typically in a `finally` block).
   */
  async function resolveAdapterTestExecutionContext(input: {
    companyId: string;
    adapterType: string;
    environmentId: string | null;
  }): Promise<{
    executionTarget: AdapterExecutionTarget | null;
    environmentName: string | null;
    fallbackChecks: AdapterEnvironmentCheck[];
    sandboxIdentityCheck?: AdapterEnvironmentCheck | null;
    release: (status?: "released" | "failed") => Promise<void>;
  }> {
    const noopRelease = async () => {};

    if (!input.environmentId) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    const environment = await environmentsSvc.getById(input.environmentId);
    if (!environment) {
      return {
        executionTarget: null,
        environmentName: null,
        fallbackChecks: [
          {
            code: "environment_not_found",
            level: "warn",
            message: "Selected environment was not found. The test did not run.",
          },
        ],
        release: noopRelease,
      };
    }

    if (environment.driver === "local") {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [],
        release: noopRelease,
      };
    }

    if (environment.driver === "ssh") {
      try {
        const target = await resolveEnvironmentExecutionTarget({
          db,
          companyId: input.companyId,
          adapterType: input.adapterType,
          environment: {
            id: environment.id,
            driver: environment.driver,
            config: environment.config ?? null,
          },
          leaseMetadata: null,
        });
        if (target) {
          return {
            executionTarget: target,
            environmentName: environment.name,
            fallbackChecks: [],
            release: noopRelease,
          };
        }
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_unavailable",
              level: "warn",
              message:
                `Could not resolve an execution target for environment "${environment.name}". The test did not run.`,
            },
          ],
          release: noopRelease,
        };
      } catch (err) {
        return {
          executionTarget: null,
          environmentName: environment.name,
          fallbackChecks: [
            {
              code: "environment_target_failed",
              level: "warn",
              message:
                `Could not connect to environment "${environment.name}" to run the test.`,
              detail: err instanceof Error ? err.message : String(err),
            },
          ],
          release: noopRelease,
        };
      }
    }

    // sandbox / plugin / other remote drivers: spin up an ad-hoc lease, realize
    // the workspace inside the box, and run the same probe SSH uses against
    // a sandbox execution target wired to the environment runtime.
    //
    // We pass `heartbeatRunId: null` because there's no heartbeat run for an
    // operator-initiated `Test` invocation — the leases table FKs heartbeat
    // run id to heartbeat_runs.id, and we don't want to manufacture a fake
    // run row. Cleanup goes through the driver's `releaseRunLease` directly
    // (by lease record), since the batch helper queries by heartbeatRunId.
    //
    // Sandbox tests boot a fresh throwaway sandbox (never resume a retained
    // agent lease) and archive it on release instead of deleting it, so the
    // operator can inspect the exact sandbox from the provider dashboard while
    // provider-side expiry reaps it later.
    const testEnvironment = environment.driver === "sandbox"
      ? {
          ...environment,
          config: {
            ...(environment.config ?? {}),
            reuseLease: false,
            archiveOnRelease: true,
          },
        }
      : environment;
    let leaseRecord: Awaited<ReturnType<typeof environmentRuntime.acquireRunLease>>;
    try {
      leaseRecord = await environmentRuntime.acquireRunLease({
        companyId: input.companyId,
        environment: testEnvironment,
        issueId: null,
        heartbeatRunId: null,
        persistedExecutionWorkspace: null,
        // Apply the active custom-image template so the Test boots with the
        // operator's captured sandbox customizations and prepared image state,
        // matching what real agent runs use. Without this the test would
        // silently fall back to the base image.
        applyCustomImageTemplate: true,
      });
    } catch (err) {
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_lease_acquire_failed",
            level: "error",
            message: `Could not acquire a lease for environment "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
            hint: "Check the environment's provider credentials and quota.",
          },
        ],
        release: noopRelease,
      };
    }

    const driver = environmentRuntime.getDriver(environment.driver);
    const releaseLease = async (status: "released" | "failed" = "released") => {
      try {
        if (driver) {
          await driver.releaseRunLease({
            environment: testEnvironment,
            lease: leaseRecord.lease,
            status,
          });
        } else {
          await environmentsSvc.releaseLease(leaseRecord.lease.id, status);
        }
      } catch (err) {
        // Cleanup failures must not mask the test result.
        // eslint-disable-next-line no-console
        console.warn(
          `[adapter-test] Failed to release lease ${leaseRecord.lease.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    let realizedCwd: string | null = null;
    try {
      const realized = await environmentRuntime.realizeWorkspace({
        environment: testEnvironment,
        lease: leaseRecord.lease,
        // No host workspace to copy for a Test invocation; sandbox/plugin
        // realize implementations use the lease metadata's remoteCwd to
        // create the working directory inside the box.
        workspace: {},
      });
      realizedCwd =
        typeof realized.cwd === "string" && realized.cwd.trim().length > 0
          ? realized.cwd.trim()
          : null;
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_workspace_realize_failed",
            level: "error",
            message: `Could not realize a workspace inside "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    let target: AdapterExecutionTarget | null;
    try {
      // Prefer the cwd the realize step returned; fall back to lease metadata.
      const leaseMetadataForTarget: Record<string, unknown> | null =
        realizedCwd
          ? { ...(leaseRecord.lease.metadata ?? {}), remoteCwd: realizedCwd }
          : (leaseRecord.lease.metadata as Record<string, unknown> | null) ?? null;

      target = await resolveEnvironmentExecutionTarget({
        db,
        companyId: input.companyId,
        adapterType: input.adapterType,
        environment: {
          id: testEnvironment.id,
          driver: testEnvironment.driver,
          config: testEnvironment.config ?? null,
        },
        leaseId: leaseRecord.lease.id,
        leaseMetadata: leaseMetadataForTarget,
        lease: leaseRecord.lease,
        environmentRuntime,
      });
    } catch (err) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_failed",
            level: "error",
            message: `Could not resolve a sandbox execution target for "${environment.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        release: noopRelease,
      };
    }

    if (!target) {
      await releaseLease("failed");
      return {
        executionTarget: null,
        environmentName: environment.name,
        fallbackChecks: [
          {
            code: "environment_target_unsupported",
            level: "warn",
            message:
              `Adapter "${input.adapterType}" is not allowed in "${environment.name}" environments.`,
          },
        ],
        release: noopRelease,
      };
    }

    return {
      executionTarget: target,
      environmentName: environment.name,
      fallbackChecks: [],
      sandboxIdentityCheck: buildSandboxIdentityCheck({
        environmentName: environment.name,
        lease: leaseRecord.lease,
      }),
      release: releaseLease,
    };
  }

  function readMetadataString(metadata: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  }

  function buildSandboxIdentityCheck(input: {
    environmentName: string;
    lease: {
      id: string;
      provider?: string | null;
      providerLeaseId?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }): AdapterEnvironmentCheck {
    const metadata = input.lease.metadata ?? {};
    const provider = input.lease.provider ?? readMetadataString(metadata, ["provider"]);
    const sandboxId = readMetadataString(metadata, ["sandboxId", "sandboxID", "sandbox_id", "id"]);
    const sandboxName = readMetadataString(metadata, ["sandboxName", "sandbox_name", "name"]);
    const snapshotRef = readMetadataString(metadata, [
      "snapshot",
      "snapshotId",
      "snapshotID",
      "snapshotRef",
      "snapshot_ref",
      "templateRef",
      "template_ref",
      "templateId",
      "templateID",
      "image",
      "imageId",
      "imageID",
      "imageRef",
      "image_ref",
    ]);
    const templateKind = readMetadataString(metadata, [
      "templateKind",
      "template_kind",
      "templateRefKind",
      "template_ref_kind",
    ]);
    const detailParts = [
      `paperclipLeaseId=${input.lease.id}`,
      input.lease.providerLeaseId ? `providerLeaseId=${input.lease.providerLeaseId}` : null,
      provider ? `provider=${provider}` : null,
      sandboxId ? `sandboxId=${sandboxId}` : null,
      sandboxName ? `sandboxName=${sandboxName}` : null,
      snapshotRef ? `${templateKind ? `${templateKind}Ref` : "snapshotOrTemplateRef"}=${snapshotRef}` : null,
    ].filter((part): part is string => Boolean(part));

    return {
      code: "sandbox_test_identity",
      level: "info",
      message: `Sandbox test identity for "${input.environmentName}".`,
      detail: detailParts.join("; "),
      hint: "Use these provider-neutral IDs when comparing model-test output with provider logs or refreshed sandbox snapshots.",
    };
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.companyId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.companyId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (canCreateAgents(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "agent_creator" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    if (membership?.status === "active") {
      return {
        canAssignTasks: true,
        taskAssignSource: "simple_default" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  async function resolveAgentSelfTrustPreset(req: Request, agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    if (req.actor.type !== "agent" || req.actor.agentId !== agent.id) {
      return { kind: "standard" as const };
    }
    const run = req.actor.type === "agent" && req.actor.runId
      ? await db
          .select({
            companyId: heartbeatRuns.companyId,
            agentId: heartbeatRuns.agentId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, req.actor.runId), eq(heartbeatRuns.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const runContext = run?.agentId === agent.id ? readObject(run.contextSnapshot) : null;
    const runExecutionPolicy = readObject(runContext?.executionPolicy);
    const runIssueId = readRunIssueId(runContext);
    const runScopedIssue = runIssueId
      ? await db
          .select({
            companyId: issuesTable.companyId,
            projectId: issuesTable.projectId,
            executionPolicy: issuesTable.executionPolicy,
            projectExecutionWorkspacePolicy: projectsTable.executionWorkspacePolicy,
          })
          .from(issuesTable)
          .leftJoin(projectsTable, and(eq(projectsTable.id, issuesTable.projectId), eq(projectsTable.companyId, issuesTable.companyId)))
          .where(and(eq(issuesTable.id, runIssueId), eq(issuesTable.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;

    return resolveCoreTrustPreset({
      companyId: agent.companyId,
      agent,
      project: runScopedIssue?.projectId
        ? {
            companyId: runScopedIssue.companyId,
            executionWorkspacePolicy: runScopedIssue.projectExecutionWorkspacePolicy,
          }
        : null,
      issue: runScopedIssue
        ? {
            companyId: runScopedIssue.companyId,
            executionPolicy: runScopedIssue.executionPolicy,
          }
        : null,
      run: runExecutionPolicy ? { companyId: agent.companyId, executionPolicy: runExecutionPolicy } : null,
    });
  }

  function buildLowTrustSelfView(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
    };
  }

  async function applyDefaultAgentTaskAssignGrant(
    companyId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    if (req.actor.type !== "agent") return null;
    const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return actorAgent;
  }

  async function assertBoardCanManageAgentsForCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanReadConfigurations(req: Request, companyId: string) {
    // Reading agent configurations, skills, and config revisions is a
    // read-only operation available to any board (human) member of the
    // company. Responses go through `redactAgentConfiguration` so secrets
    // are never exposed. Mutations and environment probes still gate on
    // agents:create or agents:configure via the mutating route helpers.
    //
    // For AGENT actors we keep a stricter gate: an agent must have either
    // agents:configure or agents:suggest-changes before it can inspect peer
    // agent configuration for a proposed diff.
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      const decision = await access.decide({
        actor: req.actor,
        action: "agent_config:read",
        resource: { type: "company", companyId },
      });
      if (!decision.allowed) {
        throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
      }
      return req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
    }
    return null;
  }

  async function getAccessibleAgent(req: Request, res: Response, id: string) {
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return null;
    if (req.actor.type === "board") {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    return agent;
  }

  // ---------------------------------------------------------------------------
  // Per-user agent visibility. A privileged board actor (the local implicit
  // board, an instance admin, or a company owner/admin) sees every agent in the
  // company. A non-privileged board user (operator/viewer) sees ONLY the agents
  // they have explicitly joined (agent_memberships.state = "joined"). Agent-key
  // actors are unaffected (their access is already bounded by company match).
  //
  // This deliberately only NARROWS access, and only for non-privileged users, so
  // it is inert in local_trusted mode (the implicit board is privileged) and
  // takes effect once the instance runs in authenticated mode.
  function isPrivilegedAgentViewer(req: Request, companyId: string): boolean {
    if (!restrictAgentVisibility) return true;
    if (req.actor.type !== "board") return true;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    const role = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((m) => m.companyId === companyId)?.membershipRole
      : undefined;
    return role === "owner" || role === "admin";
  }

  // Agents a user may see under restricted visibility: their joined agents PLUS
  // every agent transitively reporting to one (hierarchical "manager sees
  // reports' agents", via authz.getVisibleAgentIds / agents.reportsTo).
  async function visibleAgentIds(companyId: string, userId: string): Promise<Set<string>> {
    return getVisibleAgentIds(db, companyId, userId);
  }

  /** True if this request's actor is allowed to see the given agent. */
  async function actorCanSeeAgent(
    req: Request,
    agent: { id: string; companyId: string },
  ): Promise<boolean> {
    if (isPrivilegedAgentViewer(req, agent.companyId)) return true;
    if (req.actor.type === "agent") return true;
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    if (!userId) return false;
    const visible = await visibleAgentIds(agent.companyId, userId);
    return visible.has(agent.id);
  }

  async function actorCanReadConfigurationsForCompany(req: Request, companyId: string) {
    // Mirrors assertCanReadConfigurations but returns a boolean instead of
    // throwing. Board actors only need company access; agent actors must pass
    // the agent configuration read grant ladder so peer agents cannot snoop
    // each others' configurations.
    try {
      assertCompanyAccess(req, companyId);
    } catch {
      return false;
    }
    if (req.actor.type === "board") return true;
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function buildSkippedWakeupResponse(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    payload: Record<string, unknown> | null | undefined,
  ) {
    const issueId = typeof payload?.issueId === "string" && payload.issueId.trim() ? payload.issueId : null;
    if (!issueId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId: null,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const issue = await db
      .select({
        id: issuesTable.id,
        executionRunId: issuesTable.executionRunId,
      })
      .from(issuesTable)
      .where(and(eq(issuesTable.id, issueId), eq(issuesTable.companyId, agent.companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issue?.executionRunId) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: null,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionRun = await heartbeat.getRun(issue.executionRunId);
    if (!executionRun || (executionRun.status !== "queued" && executionRun.status !== "running")) {
      return {
        status: "skipped" as const,
        reason: "wakeup_skipped",
        message: "Wakeup was skipped.",
        issueId,
        executionRunId: issue.executionRunId,
        executionAgentId: null,
        executionAgentName: null,
      };
    }

    const executionAgent = await svc.getById(executionRun.agentId);
    const executionAgentName = executionAgent?.name ?? null;

    return {
      status: "skipped" as const,
      reason: "issue_execution_deferred",
      message: executionAgentName
        ? `Wakeup was deferred because this issue is already being executed by ${executionAgentName}.`
        : "Wakeup was deferred because this issue already has an active execution run.",
      issueId,
      executionRunId: executionRun.id,
      executionAgentId: executionRun.agentId,
      executionAgentName,
    };
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    if (!hasCompanyAccess(req, targetAgent.companyId)) {
      throw notFound("Agent not found");
    }
    assertCompanyAccess(req, targetAgent.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanReadAgent(req: Request, targetAgent: { id: string; companyId: string }) {
    if (!hasCompanyAccess(req, targetAgent.companyId)) {
      throw notFound("Agent not found");
    }
    assertCompanyAccess(req, targetAgent.companyId);
    if (req.actor.type === "board") {
      await assertCanReadConfigurations(req, targetAgent.companyId);
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== targetAgent.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:read",
      resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
    });
    if (decision.allowed) return;

    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  function assertKnownAdapterType(type: string | null | undefined): string {
    const adapterType = typeof type === "string" ? type.trim() : "";
    if (!adapterType) {
      throw unprocessable("Adapter type is required");
    }
    if (!findServerAdapter(adapterType)) {
      throw unprocessable(`Unknown adapter type: ${adapterType}`);
    }
    return adapterType;
  }

  async function assertAgentDefaultEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
    options?: { allowedDrivers?: string[]; allowedSandboxProviders?: string[] },
  ) {
    if (environmentId === undefined || environmentId === null) return;
    const environment = await environmentsSvc.getById(environmentId);
    if (!environment) {
      throw unprocessable("Selected environment was not found");
    }
    if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
      throw unprocessable(`Environment driver "${environment.driver}" is not allowed here`);
    }
    if (environment.driver === "sandbox" && options?.allowedSandboxProviders) {
      const config = environment.config && typeof environment.config === "object"
        ? environment.config as Record<string, unknown>
        : {};
      const provider = typeof config.provider === "string" ? config.provider : "";
      if (provider === "fake") {
        throw unprocessable(
          `Selected sandbox provider "${provider}" is not supported for agent defaults yet`,
        );
      }
      if (options.allowedSandboxProviders.length > 0 && !options.allowedSandboxProviders.includes(provider)) {
        throw unprocessable(
          `Selected sandbox provider "${provider || "unknown"}" is not supported for agent defaults yet`,
        );
      }
    }
  }

  function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
  }

  function allowedEnvironmentDriversForAgent(adapterType: string): string[] {
    return supportedEnvironmentDriversForAdapter(adapterType);
  }

  function allowedSandboxProvidersForAgent(adapterType: string): string[] | undefined {
    return supportedEnvironmentDriversForAdapter(adapterType).includes("sandbox") ? [] : [];
  }

  async function resolveCompanyIdForAgentReference(req: Request): Promise<string | null> {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    // Board user with a single active company membership → use that company implicitly.
    // This avoids requiring ?companyId= on every shortname lookup for single-company deploys.
    if (req.actor.type === "board" && Array.isArray(req.actor.memberships)) {
      const active = req.actor.memberships.filter((m) => m.status === "active");
      if (active.length === 1) {
        assertCompanyAccess(req, active[0].companyId);
        return active[0].companyId;
      }
    }
    return null;
  }

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const companyId = await resolveCompanyIdForAgentReference(req);
    if (!companyId) {
      throw unprocessable("Agent shortname lookup requires companyId query parameter");
    }

    const resolved = await svc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function asEnvBindingString(value: unknown): string | null {
    const direct = asNonEmptyString(value);
    if (direct) return direct;
    const record = asRecord(value);
    if (record?.type !== "plain") return null;
    return asNonEmptyString(record.value);
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? false,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
    const parsedRuntimeConfig = asRecord(runtimeConfig);
    const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
    const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
    const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

    if (parseBooleanLike(heartbeat.enabled) == null) {
      heartbeat.enabled = false;
    }
    if (parseNumberLike(heartbeat.maxConcurrentRuns) == null) {
      heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
    }

    normalizedRuntimeConfig.heartbeat = heartbeat;
    return normalizedRuntimeConfig;
  }

  function listRuntimeModelProfileAdapterConfigs(runtimeConfig: unknown): Array<{
    profileKey: string;
    profile: Record<string, unknown>;
    adapterConfig: Record<string, unknown>;
    path: string;
  }> {
    const runtimeRecord = asRecord(runtimeConfig);
    const modelProfiles = asRecord(runtimeRecord?.modelProfiles);
    if (!modelProfiles) return [];

    const entries: Array<{
      profileKey: string;
      profile: Record<string, unknown>;
      adapterConfig: Record<string, unknown>;
      path: string;
    }> = [];
    for (const [profileKey, rawProfile] of Object.entries(modelProfiles)) {
      const profile = asRecord(rawProfile);
      const adapterConfig = asRecord(profile?.adapterConfig);
      if (!profile || !adapterConfig) continue;
      entries.push({
        profileKey,
        profile,
        adapterConfig,
        path: `runtimeConfig.modelProfiles.${profileKey}.adapterConfig`,
      });
    }
    return entries;
  }

  function assertNoAgentRuntimeConfigAdapterConfigMutation(req: Request, runtimeConfig: unknown) {
    for (const entry of listRuntimeModelProfileAdapterConfigs(runtimeConfig)) {
      assertNoAgentAdapterConfigMutation(req, entry.adapterConfig, entry.path);
    }
  }

  async function normalizeMediatedAdapterConfigForPersistence(input: {
    companyId: string;
    adapterType: string | null | undefined;
    adapterConfig: Record<string, unknown>;
    constraintAdapterConfig?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      input.companyId,
      input.adapterConfig,
      {
        strictMode: strictSecretsMode,
        adapterType: input.adapterType ?? null,
      },
    );
    await assertAdapterConfigConstraints(
      input.adapterType,
      input.constraintAdapterConfig
        ? { ...input.constraintAdapterConfig, ...normalizedAdapterConfig }
        : normalizedAdapterConfig,
    );
    return normalizedAdapterConfig;
  }

  async function normalizeRuntimeConfigAdapterConfigsForPersistence(
    companyId: string,
    adapterType: string,
    runtimeConfig: Record<string, unknown>,
    baseAdapterConfig: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const entries = listRuntimeModelProfileAdapterConfigs(runtimeConfig);
    if (entries.length === 0) return runtimeConfig;
    const adapterModelProfiles = await listAdapterModelProfiles(adapterType);

    const normalizedRuntimeConfig = { ...runtimeConfig };
    const modelProfiles = asRecord(runtimeConfig.modelProfiles) ?? {};
    const normalizedModelProfiles = { ...modelProfiles };
    normalizedRuntimeConfig.modelProfiles = normalizedModelProfiles;

    for (const entry of entries) {
      const adapterProfile = adapterModelProfiles.find((profile) => profile.key === entry.profileKey);
      const adapterDefaultConfig = asRecord(adapterProfile?.adapterConfig) ?? {};
      const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId,
        adapterType,
        adapterConfig: entry.adapterConfig,
        constraintAdapterConfig: {
          ...baseAdapterConfig,
          ...adapterDefaultConfig,
        },
      });
      normalizedModelProfiles[entry.profileKey] = {
        ...entry.profile,
        adapterConfig: normalizedAdapterConfig,
      };
    }

    return normalizedRuntimeConfig;
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "openclaw_gateway") return adapterConfig;
    const disableDeviceAuth = parseBooleanLike(adapterConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return adapterConfig;
    if (asNonEmptyString(adapterConfig.devicePrivateKeyPem)) return adapterConfig;
    return { ...adapterConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function codexLocalAgentHome(companyId: string, agentId: string): string {
    const instanceRoot = resolvePaperclipInstanceRootForAdapter({
      homeDir: asNonEmptyString(process.env.PAPERCLIP_HOME) ?? undefined,
      instanceId: asNonEmptyString(process.env.PAPERCLIP_INSTANCE_ID) ?? undefined,
      env: process.env,
    });
    return path.resolve(instanceRoot, "companies", companyId, "agents", agentId, "codex-home");
  }

  function codexLocalEnvKeyConfigured(value: unknown): boolean {
    if (asEnvBindingString(value)) return true;
    const record = asRecord(value);
    return record?.type === "secret_ref" && typeof record.secretId === "string";
  }

  // codex_local agents inherit whatever Codex login is already on the device
  // (the host's ~/.codex or $CODEX_HOME) by default, so a fresh agent needs no
  // env overrides at all. We only carve out an isolated per-agent CODEX_HOME
  // when the agent sets its own OPENAI_API_KEY, so that key's api-key auth.json
  // does not collide with the shared company home other agents use for the host
  // login. Agents without a key share the host credentials.
  function applyCodexLocalKeyIsolation(
    companyId: string,
    agentId: string,
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (adapterType !== "codex_local") return adapterConfig;
    const existingEnv = asRecord(adapterConfig.env);
    if (!existingEnv) return adapterConfig;
    if (!codexLocalEnvKeyConfigured(existingEnv.OPENAI_API_KEY)) return adapterConfig;
    if (codexLocalEnvKeyConfigured(existingEnv.CODEX_HOME)) return adapterConfig;
    return {
      ...adapterConfig,
      env: { ...existingEnv, CODEX_HOME: codexLocalAgentHome(companyId, agentId) },
    };
  }

  function applyCreateDefaultsByAdapterType(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...adapterConfig };
    if (adapterType === "codex_local") {
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "opencode_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_OPENCODE_LOCAL_MODEL;
      return ensureGatewayDeviceKey(adapterType, next);
    }
    if (adapterType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return ensureGatewayDeviceKey(adapterType, next);
  }

  async function assertAdapterConfigConstraints(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    if (adapterType !== "opencode_local") return;
    try {
      requireOpenCodeModelId(adapterConfig.model);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local adapterConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, adapterConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(adapterConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires adapterConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("adapterConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    companyId: string;
    name: string;
    role: string;
    adapterType: string;
    adapterConfig: unknown;
  }>(
    agent: T,
    input?: { files: Record<string, string>; entryFile?: string },
  ): Promise<T> {
    if (!adapterSupportsInstructionsBundle(agent.adapterType)) {
      return agent;
    }

    const adapterConfig = asRecord(agent.adapterConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(adapterConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(adapterConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(adapterConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(adapterConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(adapterConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      const nextAdapterConfig = { ...adapterConfig };
      const hadLegacyPrompt =
        Object.prototype.hasOwnProperty.call(nextAdapterConfig, "promptTemplate")
        || Object.prototype.hasOwnProperty.call(nextAdapterConfig, "bootstrapPromptTemplate");
      delete nextAdapterConfig.promptTemplate;
      delete nextAdapterConfig.bootstrapPromptTemplate;
      if (!hadLegacyPrompt) return agent;

      const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig }, {
        allowPendingApprovalConfigUpdate: true,
      });
      return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
    }

    const files = input?.files
      ?? await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role));
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: input?.entryFile ?? "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.adapterConfig };
    delete nextAdapterConfig.promptTemplate;
    delete nextAdapterConfig.bootstrapPromptTemplate;

    const updated = await svc.update(agent.id, { adapterConfig: nextAdapterConfig }, {
      allowPendingApprovalConfigUpdate: true,
    });
    return (updated as T | null) ?? { ...agent, adapterConfig: nextAdapterConfig };
  }

  function assertNoNewAgentLegacyPromptTemplate(adapterType: string, adapterConfig: Record<string, unknown>) {
    if (!adapterSupportsInstructionsBundle(adapterType)) return;
    if (
      Object.prototype.hasOwnProperty.call(adapterConfig, "promptTemplate")
      || Object.prototype.hasOwnProperty.call(adapterConfig, "bootstrapPromptTemplate")
    ) {
      throw unprocessable(
        "New agents must use instructionsBundle/AGENTS.md instead of adapterConfig.promptTemplate or bootstrapPromptTemplate",
      );
    }
  }

  async function assertCanApplyProtectedAgentChange(
    req: Request,
    targetAgent: { id: string; companyId: string },
    targetKeys: string[],
  ) {
    if (!hasCompanyAccess(req, targetAgent.companyId)) {
      throw notFound("Agent not found");
    }
    assertCompanyAccess(req, targetAgent.companyId);
    const changeScope = { requiresChangeGrant: true };
    const decision = await access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
      scope: changeScope,
    });
    if (decision.allowed) {
      return;
    }

    if (decision.reason === "deny_missing_consent" && req.actor.type === "agent" && targetKeys.length > 0) {
      try {
        await changeConsentGateService(db).assertConsented({
          companyId: targetAgent.companyId,
          actorAgentId: req.actor.agentId,
          actorRunId: req.actor.runId ?? null,
          targetKeys,
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
        }
        throw err;
      }

      const consentedDecision = await access.decide({
        actor: req.actor,
        action: "agent_config:update",
        resource: { type: "agent", companyId: targetAgent.companyId, agentId: targetAgent.id },
        scope: { ...changeScope, consentedChange: true },
      });
      if (consentedDecision.allowed) {
        return;
      }
      throw forbidden(consentedDecision.explanation, authorizationDeniedDetails(consentedDecision));
    }

    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  async function assertCanManageInstructionsPath(req: Request, targetAgent: { id: string; companyId: string }) {
    await assertCanApplyProtectedAgentChange(
      req,
      targetAgent,
      [agentInstructionsChangeTargetKey(targetAgent.id)],
    );
  }

  async function assertCanApplyAgentProfileChange(
    req: Request,
    targetAgent: { id: string; companyId: string },
  ) {
    await assertCanApplyProtectedAgentChange(
      req,
      targetAgent,
      [agentProfileChangeTargetKey(targetAgent.id)],
    );
  }

  function assertNoAgentInstructionsConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown> | null | undefined,
    path = "adapterConfig",
  ) {
    if (req.actor.type !== "agent" || !adapterConfig) return;
    const changedSensitiveKeys = KNOWN_INSTRUCTIONS_BUNDLE_KEYS
      .filter((key) => adapterConfig[key] !== undefined)
      .map((key) => `${path}.${key}`);
    if (changedSensitiveKeys.length === 0) return;
    throw forbidden(
      `Agent-authenticated callers cannot modify instructions path or bundle configuration (${changedSensitiveKeys.join(", ")})`,
    );
  }

  function adapterConfigTouchesInstructionsConfig(adapterConfig: Record<string, unknown>) {
    return KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => adapterConfig[key] !== undefined);
  }

  function assertNoAgentAdapterConfigMutation(
    req: Request,
    adapterConfig: Record<string, unknown>,
    path = "adapterConfig",
  ) {
    assertNoAgentInstructionsConfigMutation(req, adapterConfig, path);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectAgentAdapterWorkspaceCommandPaths(adapterConfig, path),
    );
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const adapterConfigPatch = asRecord(patch.adapterConfig);
    if (adapterConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(adapterConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    adapterType: string,
    desiredSkillEntries: AgentDesiredSkillEntry[] = [],
  ): AgentSkillSnapshot {
    const desiredSkills = desiredSkillEntries.map((entry) => entry.key);
    return {
      adapterType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      desiredSkillEntries,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  function normalizeDesiredSkillSelections(
    requestedDesiredSkills: Array<string | AgentDesiredSkillEntry> | undefined,
  ): AgentDesiredSkillEntry[] | undefined {
    if (!requestedDesiredSkills) return undefined;
    const out = new Map<string, AgentDesiredSkillEntry>();
    for (const value of requestedDesiredSkills) {
      const entry = typeof value === "string"
        ? { key: value.trim(), versionId: null }
        : { key: value.key.trim(), versionId: value.versionId ?? null };
      if (!entry.key || out.has(entry.key)) continue;
      out.set(entry.key, entry);
    }
    return Array.from(out.values());
  }

  // Legacy hardcoded set — used as fallback when adapter module does not
  // declare requiresMaterializedRuntimeSkills explicitly.
  const LEGACY_MATERIALIZED_SKILLS_SET = new Set([
    "cursor",
    "gemini_local",
    "opencode_local",
    "pi_local",
  ]);

  function shouldMaterializeRuntimeSkillsForAdapter(adapterType: string) {
    const adapter = findActiveServerAdapter(adapterType);
    if (adapter?.requiresMaterializedRuntimeSkills !== undefined) {
      return adapter.requiresMaterializedRuntimeSkills;
    }
    return LEGACY_MATERIALIZED_SKILLS_SET.has(adapterType);
  }

  async function buildRuntimeSkillConfig(
    companyId: string,
    adapterType: string,
    config: Record<string, unknown>,
    options: {
      materializeMissing?: boolean;
    } = {},
  ) {
    const preference = readPaperclipSkillSyncPreference(config);
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: options.materializeMissing
        ?? shouldMaterializeRuntimeSkillsForAdapter(adapterType),
      versionSelections: skillVersionSelectionMap(preference.desiredSkillEntries),
    });
    return {
      ...config,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  async function resolveDesiredSkillAssignment(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
    requestedDesiredSkills: AgentDesiredSkillEntry[] | undefined,
    options: { tolerateUnknownDesiredSkills?: boolean } = {},
  ) {
    if (!requestedDesiredSkills) {
      return {
        adapterConfig,
        desiredSkills: null as string[] | null,
        desiredSkillEntries: null as AgentDesiredSkillEntry[] | null,
        runtimeSkillEntries: null as Awaited<ReturnType<typeof companySkills.listRuntimeSkillEntries>> | null,
      };
    }

    const { resolved: resolvedRequestedSkillEntries, unresolved: unresolvedDesiredSkillKeys } =
      await companySkills.resolveRequestedSkillEntries(companyId, requestedDesiredSkills, {
        tolerateUnknownReferences: options.tolerateUnknownDesiredSkills,
      });
    // Runtime materialization + version selection only ever consider skills that
    // actually resolve to the company library; stale keys can't be materialized.
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(companyId, {
      materializeMissing: shouldMaterializeRuntimeSkillsForAdapter(adapterType),
      versionSelections: skillVersionSelectionMap(resolvedRequestedSkillEntries),
    });
    const resolvedDesiredSkillEntries = resolvedRequestedSkillEntries.filter(
      (entry, index, entries) => entries.findIndex((candidate) => candidate.key === entry.key) === index,
    );
    // Preserve stale/unresolvable keys in the persisted desired set so they stay
    // visible (and explicitly removable) instead of vanishing on the next save.
    const desiredSkillEntries: AgentDesiredSkillEntry[] = [
      ...resolvedDesiredSkillEntries,
      ...unresolvedDesiredSkillKeys.map((key) => ({ key, versionId: null })),
    ];
    const desiredSkills = desiredSkillEntries.map((entry) => entry.key);

    return {
      adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, desiredSkillEntries),
      desiredSkills,
      desiredSkillEntries,
      runtimeSkillEntries,
    };
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
    };
  }

  // Display-safe projection for the company-wide Virtual Office roster: EVERY
  // user sees every agent on the floor / catalog, but only the fields needed to
  // render them. Strips config (adapterConfig/runtimeConfig) AND narrows
  // metadata to a whitelist — metadata otherwise carries private founderDigest /
  // asanaDigest / console content that must NOT leak company-wide. Access-gated
  // detail (the 查看代理人 button → full agent) stays behind visibleAgentIds.
  const OFFICE_METADATA_KEYS = ["teams", "team", "officeCharacterId", "officeAvatarUrl"] as const;
  function redactForRosterView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    const md = agent.metadata && typeof agent.metadata === "object" ? (agent.metadata as Record<string, unknown>) : {};
    const safeMeta: Record<string, unknown> = {};
    for (const key of OFFICE_METADATA_KEYS) {
      if (key in md) safeMeta[key] = md[key];
    }
    return {
      ...agent,
      adapterConfig: {},
      runtimeConfig: {},
      metadata: safeMeta,
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      adapterType: agent.adapterType,
      adapterConfig: redactEventPayload(agent.adapterConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      adapterConfig: redactEventPayload(
        typeof record.adapterConfig === "object" && record.adapterConfig !== null
          ? (record.adapterConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/adapters/:type/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const refresh = typeof req.query.refresh === "string"
      ? ["1", "true", "yes"].includes(req.query.refresh.toLowerCase())
      : false;
    const environmentId = asNonEmptyString(req.query.environmentId);
    const environment = environmentId ? await environmentsSvc.getById(environmentId) : null;
    if (environmentId && !environment) {
      res.status(404).json({ error: "Environment not found" });
      return;
    }
    if (type === "opencode_local" && environment && environment.driver !== "local") {
      const adapter = requireServerAdapter(type);
      res.json(adapter.models ?? []);
      return;
    }
    const models = refresh
      ? await refreshAdapterModels(type)
      : await listAdapterModels(type);
    res.json(models);
  });

  router.get("/companies/:companyId/adapters/:type/model-profiles", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);
    const profiles = await listAdapterModelProfiles(type);
    res.json(profiles);
  });

  router.get("/companies/:companyId/adapters/:type/detect-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const type = assertKnownAdapterType(req.params.type as string);

    const detected = await detectAdapterModel(type);
    res.json(detected);
  });

  router.post(
    "/companies/:companyId/adapters/:type/test-environment",
    validate(testAdapterEnvironmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const type = assertKnownAdapterType(req.params.type as string);
      await assertCanCreateAgentsForCompany(req, companyId);

      const adapter = requireServerAdapter(type);

      const inputAdapterConfig =
        (req.body?.adapterConfig ?? {}) as Record<string, unknown>;
      const requestedEnvironmentId =
        typeof req.body?.environmentId === "string" && req.body.environmentId.trim().length > 0
          ? (req.body.environmentId as string)
          : null;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode, adapterType: type },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        companyId,
        normalizedAdapterConfig,
        undefined,
        { adapterType: type },
      );

      const { executionTarget, environmentName, fallbackChecks, sandboxIdentityCheck, release } =
        await resolveAdapterTestExecutionContext({
          companyId,
          adapterType: type,
          environmentId: requestedEnvironmentId,
        });

      let releaseStatus: "released" | "failed" = "released";
      try {
        // If the caller explicitly selected an environment, never fall back to
        // probing the host when we couldn't resolve that environment's
        // execution target. Surface the diagnostic checks instead.
        if (requestedEnvironmentId && !executionTarget && fallbackChecks.length > 0) {
          const status: AdapterEnvironmentTestResult["status"] = fallbackChecks.some((c) => c.level === "error")
            ? "fail"
            : fallbackChecks.some((c) => c.level === "warn")
              ? "warn"
              : "pass";
          if (status === "fail") releaseStatus = "failed";
          const synthesized: AdapterEnvironmentTestResult = {
            adapterType: type,
            status,
            checks: fallbackChecks,
            testedAt: new Date().toISOString(),
          };
          res.json(synthesized);
          return;
        }

        const result = await adapter.testEnvironment({
          companyId,
          adapterType: type,
          config: runtimeAdapterConfig,
          executionTarget,
          environmentName,
        });

        if (result.status === "fail") releaseStatus = "failed";
        res.json({
          ...result,
          checks: sandboxIdentityCheck ? [sandboxIdentityCheck, ...result.checks] : result.checks,
        });
      } catch (err) {
        releaseStatus = "failed";
        throw err;
      } finally {
        await release(releaseStatus);
      }
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);

    const adapter = findActiveServerAdapter(agent.adapterType);
    if (!adapter?.listSkills) {
      const preference = readPaperclipSkillSyncPreference(
        agent.adapterConfig as Record<string, unknown>,
      );
      const desiredSkillEntries = preference.desiredSkillEntries.filter(
        (entry, index, entries) => entries.findIndex((candidate) => candidate.key === entry.key) === index,
      );
      res.json(buildUnsupportedSkillSnapshot(agent.adapterType, desiredSkillEntries));
      return;
    }

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      agent.adapterConfig,
      undefined,
      { adapterType: agent.adapterType, skipUserSecrets: true },
    );
    const runtimeSkillConfig = await buildRuntimeSkillConfig(
      agent.companyId,
      agent.adapterType,
      runtimeConfig,
      { materializeMissing: false },
    );
    const snapshot = await adapter.listSkills({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      config: runtimeSkillConfig,
    });
    res.json(snapshot);
  });

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
      if (!agent) return;
      await assertCanUpdateAgent(req, agent);

      const requestedSkills = normalizeDesiredSkillSelections(req.body.desiredSkills);
      const {
        adapterConfig: nextAdapterConfig,
        desiredSkills,
        desiredSkillEntries,
        runtimeSkillEntries,
      } = await resolveDesiredSkillAssignment(
        agent.companyId,
        agent.adapterType,
        agent.adapterConfig as Record<string, unknown>,
        requestedSkills,
        // Toggling a resolvable skill must not fail just because the agent
        // already carries stale desired keys (e.g. a skill removed from the
        // library). Preserve those keys so they remain visible/removable.
        { tolerateUnknownDesiredSkills: true },
      );
      if (!desiredSkills || !desiredSkillEntries || !runtimeSkillEntries) {
        throw unprocessable("Skill sync requires desiredSkills.");
      }
      const actor = getActorInfo(req);
      const updated = await svc.update(agent.id, {
        adapterConfig: nextAdapterConfig,
      }, {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "skill-sync",
        },
      });
      if (!updated) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Equipping a PRIVATE skill to an agent ("Add to agent") should also let
      // the agent's OWNER user(s) see/manage it in the skills store — otherwise
      // the agent runs the skill but its owner can't find it (the skill stays
      // hidden because they're not an access member). Grant that access here,
      // idempotently. Mirrors the create-time equipAgentIds behaviour.
      try {
        const ownerRows = await db
          .select({ userId: agentMemberships.userId })
          .from(agentMemberships)
          .where(and(
            eq(agentMemberships.companyId, updated.companyId),
            eq(agentMemberships.agentId, updated.id),
            eq(agentMemberships.state, "joined"),
          ));
        const ownerUserIds = ownerRows.map((r) => r.userId).filter((v): v is string => Boolean(v));
        if (ownerUserIds.length > 0) {
          for (const key of desiredSkills) {
            const skill = await companySkills.getByKey(updated.companyId, key).catch(() => null);
            if (skill && skill.sharingScope === "private") {
              for (const uid of ownerUserIds) {
                await companySkills.addSkillAccessMember(updated.companyId, skill.id, uid);
              }
            }
          }
        }
      } catch (err) {
        console.error("[agents/skills/sync] failed to grant owner access for equipped private skills", err);
      }

      const adapter = findActiveServerAdapter(updated.adapterType);
      const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        updated.companyId,
        updated.adapterConfig,
        undefined,
        { adapterType: updated.adapterType, skipUserSecrets: true },
      );
      const runtimeSkillConfig = {
        ...runtimeConfig,
        paperclipRuntimeSkills: runtimeSkillEntries,
      };
      const snapshot = adapter?.syncSkills
        ? await adapter.syncSkills({
            agentId: updated.id,
            companyId: updated.companyId,
            adapterType: updated.adapterType,
            config: runtimeSkillConfig,
          }, desiredSkills)
        : adapter?.listSkills
          ? await adapter.listSkills({
              agentId: updated.id,
              companyId: updated.companyId,
              adapterType: updated.adapterType,
              config: runtimeSkillConfig,
            })
          : buildUnsupportedSkillSnapshot(updated.adapterType, desiredSkillEntries);

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.skills_synced",
        entityType: "agent",
        entityId: updated.id,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        details: {
          adapterType: updated.adapterType,
          desiredSkills,
          desiredSkillEntries,
          mode: snapshot.mode,
          supported: snapshot.supported,
          entryCount: snapshot.entries.length,
          warningCount: snapshot.warnings.length,
        },
      });

      res.json(snapshot);
    },
  );

  // Distribute a skill to a CHOSEN SET of agents in one call — the manager-to-team
  // primitive. Unlike /skills/sync (which REPLACES one agent's whole skill set),
  // this ADDS the skill(s) to each target's existing skills (mode "add", the
  // default) so a manager can hand a skill to exactly the people they name —
  // "give this to A and B, not C" — by passing that explicit targetAgentIds list.
  // The caller resolves who to include (e.g. from GET /companies/:id/agents,
  // filtering by reportsTo / the reporting subtree / a team) and trims it per the
  // manager's intent; this endpoint just applies it.
  //
  // Security: every target passes the SAME per-agent gate as a single sync
  // (assertCanUpdateAgent), so a caller can only equip agents it may already
  // configure — no broader authority is granted here. Idempotent per target
  // (a target that already has the skill is a no-op) and best-effort: one
  // target's failure never blocks the others; each target's outcome is reported.
  router.post("/agents/:id/skills/distribute", async (req, res) => {
    const managerId = req.params.id as string;
    const manager = await svc.getById(managerId);
    if (!manager) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, manager.companyId);

    const body = (req.body ?? {}) as {
      skill?: unknown;
      skills?: unknown;
      targetAgentIds?: unknown;
      excludeAgentIds?: unknown;
      scope?: unknown;
      mode?: unknown;
    };
    const rawSkills = Array.isArray(body.skills)
      ? body.skills
      : body.skill != null
        ? [body.skill]
        : [];
    const skillKeys = rawSkills
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    const mode = body.mode === "replace" ? "replace" : "add";
    if (skillKeys.length === 0) throw unprocessable("At least one skill (skill or skills[]) is required.");

    const asIdSet = (v: unknown): Set<string> =>
      new Set(
        (Array.isArray(v) ? v : [])
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim()),
      );

    // Resolve WHO to distribute to. Either an explicit list (for "A and B, not
    // C" / "just A"), or a server-resolved scope so a manager/founder can say
    // "everyone I manage" / "the 教學組 team" / "the whole company" without
    // enumerating agents client-side. `excludeAgentIds` trims a scope (e.g.
    // "everyone in the team except C").
    const explicitIds = asIdSet(body.targetAgentIds);
    const excludeIds = asIdSet(body.excludeAgentIds);

    // Fetch the company roster once — used for scope resolution AND for the
    // manager-chain permission fallback below.
    const roster = await svc.list(manager.companyId);
    const childrenByManager = new Map<string, string[]>();
    for (const a of roster) {
      if (!a.reportsTo) continue;
      const list = childrenByManager.get(a.reportsTo);
      if (list) list.push(a.id);
      else childrenByManager.set(a.reportsTo, [a.id]);
    }
    const subtreeIdsUnder = (rootId: string): Set<string> => {
      const under = new Set<string>();
      const queue = [rootId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const child of childrenByManager.get(cur) ?? []) {
          if (!under.has(child)) {
            under.add(child);
            queue.push(child);
          }
        }
      }
      return under;
    };

    let targetIds: string[];
    let scopeLabel = "explicit";
    if (explicitIds.size > 0) {
      targetIds = [...explicitIds].filter((id) => !excludeIds.has(id));
    } else if (body.scope != null) {
      const teamsOf = (a: (typeof roster)[number]): string[] => {
        const md = (a.metadata ?? null) as Record<string, unknown> | null;
        if (!md) return [];
        if (Array.isArray(md.teams)) return md.teams.filter((t): t is string => typeof t === "string");
        if (typeof md.team === "string") return [md.team];
        return [];
      };
      const scope = body.scope;
      const norm = (s: string) => s.trim().toLowerCase();
      let selected: typeof roster;
      if (scope === "company") {
        scopeLabel = "company";
        selected = roster;
      } else if (scope === "managed" || scope === "subtree") {
        scopeLabel = "managed";
        const under = subtreeIdsUnder(manager.id);
        selected = roster.filter((a) => under.has(a.id));
      } else if (scope === "direct-reports") {
        scopeLabel = "direct-reports";
        selected = roster.filter((a) => a.reportsTo === manager.id);
      } else if (typeof scope === "object" && scope !== null && typeof (scope as { team?: unknown }).team === "string") {
        const team = norm((scope as { team: string }).team);
        scopeLabel = `team:${(scope as { team: string }).team}`;
        selected = roster.filter((a) => teamsOf(a).some((t) => norm(t) === team));
      } else {
        throw unprocessable(
          'scope must be "company", "managed", "direct-reports", or { "team": "<name>" }.',
        );
      }
      targetIds = selected.map((a) => a.id).filter((id) => !excludeIds.has(id));
    } else {
      throw unprocessable("Provide targetAgentIds or a scope to distribute to.");
    }

    targetIds = Array.from(new Set(targetIds));
    if (targetIds.length === 0) throw unprocessable(`No agents resolved for distribution (scope: ${scopeLabel}).`);
    if (targetIds.length > 500) throw unprocessable("Too many targets (max 500 agents per call).");

    // Manager-chain authorization: an agent distributing to its OWN reporting
    // subtree may equip approved company skills there even WITHOUT company-wide
    // agents:create. This is the narrow power this endpoint grants (add a skill
    // only — never arbitrary config), so a mid-level manager can hand a skill to
    // their team without being able to edit unrelated agents. Only applies when
    // the acting agent IS this manager; privileged/board actors go through
    // assertCanUpdateAgent as before.
    const actingAsManager = req.actor.type === "agent" && req.actor.agentId === manager.id;
    // An agent may auto-equip a skill to its own reporting SUBTREE (the team it
    // manages) AND to its SAME-LEVEL peers (agents sharing its supervisor).
    // Distributing UPWARD to a supervisor is not auto — it needs the supervisor's
    // approval (handled separately); such targets fall through to "forbidden" here.
    const managerSubtreeIds = actingAsManager ? subtreeIdsUnder(manager.id) : new Set<string>();
    const managerPeerIds = actingAsManager
      ? new Set(
          roster
            .filter((a) => a.id !== manager.id && (a.reportsTo ?? null) === (manager.reportsTo ?? null))
            .map((a) => a.id),
        )
      : new Set<string>();
    // Owner users of an agent (the humans it's mapped to) — used to route an
    // upward-distribution approval to the RECIPIENT's own user(s) to accept.
    const ownerUserIdsOf = async (agentId: string): Promise<string[]> => {
      const rows = await db
        .select({ userId: agentMemberships.userId })
        .from(agentMemberships)
        .where(and(
          eq(agentMemberships.companyId, manager.companyId),
          eq(agentMemberships.agentId, agentId),
          eq(agentMemberships.state, "joined"),
        ));
      return Array.from(new Set(rows.map((r) => r.userId)));
    };

    // 副理/園長 及以上 (含 founder + Jay) may push skills to anyone — including
    // upward — without the recipient's approval; the recipient is only notified.
    const privilegedDistributor = isPrivilegedDistributor(manager);

    const requestedEntries = normalizeDesiredSkillSelections(skillKeys) ?? [];
    const actor = getActorInfo(req);
    const results: Array<{ agentId: string; name: string | null; status: string; detail?: string }> = [];

    for (const targetId of targetIds) {
      try {
        const target = await svc.getById(targetId);
        if (!target || target.companyId !== manager.companyId) {
          results.push({ agentId: targetId, name: null, status: "not_found" });
          continue;
        }
        let permitted = false;
        try {
          await assertCanUpdateAgent(req, target);
          permitted = true;
        } catch {
          // Fall through to the manager-chain check.
        }
        if (!permitted && (managerSubtreeIds.has(target.id) || managerPeerIds.has(target.id))) permitted = true;
        // Track whether this target was above/outside the distributor's level
        // (i.e. would normally need approval) BEFORE the privileged bypass, so we
        // know when to send the recipient a courtesy notification instead.
        const wasUpwardTarget = !permitted;
        if (!permitted && privilegedDistributor) permitted = true;
        if (!permitted) {
          // Not my team and not a peer → this target is above/outside my level.
          // Don't equip: route an approval to the RECIPIENT's own user(s) — they
          // accept the skill themselves. The skill lands only on their approval.
          const approverUserIds = await ownerUserIdsOf(target.id);
          const approval = await approvalsSvc.create(manager.companyId, {
            type: "skill_distribution",
            requestedByAgentId: manager.id,
            requestedByUserId: null,
            status: "pending",
            payload: {
              skillKeys,
              mode,
              targetAgentId: target.id,
              targetAgentName: target.name,
              distributedByAgentId: manager.id,
              distributedByAgentName: manager.name,
              approverUserIds,
            },
          });
          results.push({ agentId: targetId, name: target.name, status: "pending_approval", detail: `approval:${approval.id}` });
          continue;
        }
        // Union with the target's current skills unless explicitly replacing.
        const existing =
          readPaperclipSkillSyncPreference(target.adapterConfig as Record<string, unknown>)
            .desiredSkillEntries ?? [];
        if (mode === "add" && requestedEntries.every((e) => existing.some((x) => x.key === e.key))) {
          results.push({ agentId: targetId, name: target.name, status: "already_equipped" });
          continue;
        }
        const merged = new Map<string, AgentDesiredSkillEntry>();
        if (mode === "add") for (const e of existing) merged.set(e.key, e);
        for (const e of requestedEntries) merged.set(e.key, e);
        const nextEntries = Array.from(merged.values());

        const {
          adapterConfig: nextAdapterConfig,
          desiredSkills,
          desiredSkillEntries,
          runtimeSkillEntries,
        } = await resolveDesiredSkillAssignment(
          target.companyId,
          target.adapterType,
          target.adapterConfig as Record<string, unknown>,
          nextEntries,
        );
        if (!desiredSkills || !desiredSkillEntries || !runtimeSkillEntries) {
          results.push({ agentId: targetId, name: target.name, status: "error", detail: "skill resolution failed" });
          continue;
        }
        const updated = await svc.update(
          target.id,
          { adapterConfig: nextAdapterConfig },
          {
            recordRevision: {
              createdByAgentId: actor.agentId,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              source: "skill-distribute",
            },
          },
        );
        if (!updated) {
          results.push({ agentId: targetId, name: target.name, status: "not_found" });
          continue;
        }
        const adapter = findActiveServerAdapter(updated.adapterType);
        const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
          updated.companyId,
          updated.adapterConfig,
        );
        if (adapter?.syncSkills) {
          await adapter.syncSkills(
            {
              agentId: updated.id,
              companyId: updated.companyId,
              adapterType: updated.adapterType,
              config: { ...runtimeConfig, paperclipRuntimeSkills: runtimeSkillEntries },
            },
            desiredSkills,
          );
        }
        await logActivity(db, {
          companyId: updated.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "agent.skills_synced",
          entityType: "agent",
          entityId: updated.id,
          agentId: actor.agentId,
          runId: actor.runId,
          details: { via: "distribute", distributedBy: manager.id, skills: desiredSkills, mode },
        });
        // Privileged distributor pushed a skill UP to someone above/outside their
        // level: no approval was required, but notify the recipient's user(s) so
        // they know a skill was added to their agent.
        if (privilegedDistributor && wasUpwardTarget) {
          try {
            const recipientUserIds = await ownerUserIdsOf(target.id);
            const skillLabel = skillKeys.map((k) => k.split("/").pop()).join(", ");
            for (const uid of recipientUserIds) {
              await notifications.create({
                companyId: updated.companyId,
                userId: uid,
                kind: "skill_distributed",
                title: `${manager.name ?? "A manager"} 已為你的代理人裝備技能`,
                body: `${target.name ?? "你的代理人"} 已自動裝備：${skillLabel}`,
                link: "/skills",
                dedupeKey: `skill-distributed:${target.id}:${uid}:${skillKeys.slice().sort().join("|")}`,
              });
            }
          } catch (err) {
            console.error("[agents/skills/distribute] recipient notification failed", err);
          }
        }
        results.push({ agentId: targetId, name: target.name, status: "equipped" });
      } catch (err) {
        results.push({
          agentId: targetId,
          name: null,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    res.json({
      skills: requestedEntries.map((e) => e.key),
      mode,
      scope: scopeLabel,
      targetCount: targetIds.length,
      distributedBy: manager.id,
      summary,
      results,
    });
  });

  // The agents the current viewer may open the detail page for (virtual office
  // "查看代理人" gate). Privileged viewers (owner/admin/instance) → all; others
  // → the agents they manage/oversee (joined + reports-to subtree).
  router.get("/companies/:companyId/my-visible-agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (isPrivilegedAgentViewer(req, companyId)) {
      res.json({ privileged: true, agentIds: [] });
      return;
    }
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const ids = userId ? [...(await visibleAgentIds(companyId, userId))] : [];
    res.json({ privileged: false, agentIds: ids });
  });

  // Company-wide Virtual Office roster: ALL agents, display-safe, NO access
  // filter — so the office floor + catalog are populated for every user. Only
  // company membership is required; sensitive fields are stripped by
  // redactForRosterView. Interacting with an agent (the 查看代理人 button) is
  // still gated client-side by /my-visible-agents.
  router.get("/companies/:companyId/agents/office-roster", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const all = await svc.list(companyId);
    res.json(all.map((agent) => redactForRosterView(agent)));
  });

  router.get("/companies/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unsupportedQueryParams = Object.keys(req.query).sort();
    if (unsupportedQueryParams.length > 0) {
      res.status(400).json({
        error: `Unsupported query parameter${unsupportedQueryParams.length === 1 ? "" : "s"}: ${unsupportedQueryParams.join(", ")}`,
      });
      return;
    }
    const result = await filterAgentsForActor(req, await svc.list(companyId));
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, companyId);
    if (canReadConfigs) {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  // The agent(s) the current board user is paired with (joined) — powers the
  // "My Agent" sidebar shortcut so a user reaches their own agent in one click.
  // Board actors only; agent-key or unpaired → []. Minimal shape (no config).
  router.get("/companies/:companyId/agents/mine", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId : null;
    if (!userId) {
      res.json([]);
      return;
    }
    const joined = new Set(await getJoinedAgentIds(db, companyId, userId));
    if (joined.size === 0) {
      res.json([]);
      return;
    }
    const mine = (await svc.list(companyId)).filter(
      (agent) => joined.has(agent.id) && agent.status !== "terminated",
    );
    res.json(
      mine.map((agent) => ({
        id: agent.id,
        urlKey: agent.urlKey,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
      })),
    );
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        adapterType: agentsTable.adapterType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        companyName: companies.name,
        companyIssuePrefix: companies.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(companies, eq(agentsTable.companyId, companies.id))
      .orderBy(companies.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          companyId: row.companyId,
          companyName: row.companyName,
          companyIssuePrefix: row.companyIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          adapterType: row.adapterType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const companyOrder = left.companyName.localeCompare(right.companyName);
        if (companyOrder !== 0) return companyOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/companies/:companyId/org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/companies/:companyId/org.svg", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/companies/:companyId/org.png", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await filterAgentsForActor(req, await svc.orgForCompany(companyId), companyId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/companies/:companyId/agent-configurations", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanReadConfigurations(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const trustPreset = await resolveAgentSelfTrustPreset(req, agent);
    if (trustPreset.kind === "denied") {
      res.status(403).json({ error: trustPreset.detail });
      return;
    }
    if (trustPreset.kind === "low_trust_review") {
      res.json(buildLowTrustSelfView(agent));
      return;
    }
    if (req.actor.keyScope?.kind === "task_bridge") {
      res.json({
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        role: agent.role,
        title: agent.title,
        status: agent.status,
        keyScope: req.actor.keyScope,
      });
      return;
    }
    // Surface the *owner* (responsible user) so the agent can distinguish who
    // it belongs to (the Paperclip SSO user) from the worker/engine account it
    // runs on (its runtime userEmail / claudeAccountConfigDirs). Without this,
    // "which email are you?" gets answered with the engine login, which is
    // confusing — the two are deliberately decoupled.
    const ownerUserId = req.actor.onBehalfOfUserId ?? null;
    const owner = ownerUserId
      ? await db
          .select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
          .from(authUsers)
          .where(eq(authUsers.id, ownerUserId))
          .then((rows) => rows[0] ?? null)
      : null;
    const detail = await buildAgentDetail(agent);
    res.json({
      ...detail,
      responsibleUser: owner
        ? { id: owner.id, email: owner.email, name: owner.name }
        : null,
    });
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const issuesSvc = issueService(db);
    const recoveryActionsSvc = issueRecoveryActionService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      assigneeAgentId: req.actor.agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });
    const worktreeActivation = await resolveWorktreeRunExecutionActivationState({
      getExperimental: () => instanceSettingsService(db).getExperimental(),
    });
    const isWorktreeRuntime = isTruthyRuntimeEnvValue(process.env.PAPERCLIP_IN_WORKTREE);
    const eligibleRows = !isWorktreeRuntime
      ? rows
      : worktreeActivation.armed
      ? rows.filter((issue) => new Date(issue.createdAt) >= new Date(worktreeActivation.cutoff))
      : [];
    const issueIds = eligibleRows.map((issue) => issue.id);
    const [dependencyReadiness, recoveryActionByIssue] = await Promise.all([
      issuesSvc.listDependencyReadiness(req.actor.companyId, issueIds),
      recoveryActionsSvc.listActiveForIssues(req.actor.companyId, issueIds),
    ]);

    res.json(
      eligibleRows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
        activeRecoveryAction: recoveryActionByIssue.get(issue.id) ?? null,
        dependencyReady: dependencyReadiness.get(issue.id)?.isDependencyReady ?? true,
        unresolvedBlockerCount: dependencyReadiness.get(issue.id)?.unresolvedBlockerCount ?? 0,
        unresolvedBlockerIssueIds: dependencyReadiness.get(issue.id)?.unresolvedBlockerIssueIds ?? [],
      })),
    );
  });

  router.get("/agents/me/inbox/mine", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const query = agentMineInboxQuerySchema.parse(req.query);
    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.companyId, {
      touchedByUserId: query.userId,
      inboxArchivedByUserId: query.userId,
      status: query.status,
      limit: ISSUE_LIST_DEFAULT_LIMIT,
    });

    res.json(rows);
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    if (!(await assertAgentReadAllowed(req, res, agent))) return;
    const isSelf = req.actor.type === "agent" && req.actor.agentId === id;
    if (isSelf) {
      const trustPreset = await resolveAgentSelfTrustPreset(req, agent);
      if (trustPreset.kind === "denied") {
        res.status(403).json({ error: trustPreset.detail });
        return;
      }
      if (trustPreset.kind === "low_trust_review") {
        res.json(buildLowTrustSelfView(agent));
        return;
      }
    }
    const canReadSensitiveDetail = isSelf
      ? true
      : await actorCanReadConfigurationsForCompany(req, agent.companyId);
    if (!canReadSensitiveDetail) {
      res.json(await buildAgentDetail(agent, { restricted: true }));
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.companyId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

  router.post("/companies/:companyId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      ...hireInput
    } = req.body;
    hireInput.adapterType = assertKnownAdapterType(hireInput.adapterType);
    const rawHireAdapterConfig = (hireInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      hireInput.adapterType,
      rawHireAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawHireAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, hireInput.runtimeConfig);
    const hiredAgentId = randomUUID();
    const requestedAdapterConfig = applyCodexLocalKeyIsolation(
      companyId,
      hiredAgentId,
      hireInput.adapterType,
      applyCreateDefaultsByAdapterType(
        hireInput.adapterType,
        rawHireAdapterConfig,
      ),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      hireInput.adapterType,
      requestedAdapterConfig,
      normalizeDesiredSkillSelections(Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined),
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: hireInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      hireInput.adapterType,
      normalizeNewAgentRuntimeConfig(hireInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
    };

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(companyId, {
      id: hiredAgentId,
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.adapterType ?? agent.adapterType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.adapterConfig ?? normalizedHireInput.adapterConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: normalizedHireInput.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          adapterType: requestedAdapterType,
          adapterConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            adapterType: requestedAdapterType,
            adapterConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    res.status(201).json({ agent, approval });
  });

  router.post("/companies/:companyId/agents", validate(createAgentSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanCreateAgentsForCompany(req, companyId);

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (company.requireBoardApprovalForNewAgents) {
      throw conflict(
        "Direct agent creation requires board approval. Use POST /api/companies/:companyId/agent-hires to create a pending hire approval.",
      );
    }

    const {
      desiredSkills: requestedDesiredSkills,
      instructionsBundle,
      ...createInput
    } = req.body;
    createInput.adapterType = assertKnownAdapterType(createInput.adapterType);
    const rawCreateAdapterConfig = (createInput.adapterConfig ?? {}) as Record<string, unknown>;
    assertNoNewAgentLegacyPromptTemplate(
      createInput.adapterType,
      rawCreateAdapterConfig,
    );
    assertNoAgentAdapterConfigMutation(req, rawCreateAdapterConfig);
    assertNoAgentRuntimeConfigAdapterConfigMutation(req, createInput.runtimeConfig);
    const agentId = randomUUID();
    const requestedAdapterConfig = applyCodexLocalKeyIsolation(
      companyId,
      agentId,
      createInput.adapterType,
      applyCreateDefaultsByAdapterType(
        createInput.adapterType,
        rawCreateAdapterConfig,
      ),
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      companyId,
      createInput.adapterType,
      requestedAdapterConfig,
      normalizeDesiredSkillSelections(Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined),
    );
    const normalizedAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
      companyId,
      adapterType: createInput.adapterType,
      adapterConfig: desiredSkillAssignment.adapterConfig,
    });
    const normalizedRuntimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
      companyId,
      createInput.adapterType,
      normalizeNewAgentRuntimeConfig(createInput.runtimeConfig),
      normalizedAdapterConfig,
    );
    await assertAgentEnvironmentSelection(companyId, createInput.adapterType, createInput.defaultEnvironmentId);
    await assertAgentDefaultEnvironmentSelection(companyId, createInput.defaultEnvironmentId, {
      allowedDrivers: allowedEnvironmentDriversForAgent(createInput.adapterType),
      allowedSandboxProviders: allowedSandboxProvidersForAgent(createInput.adapterType),
    });

    const createdAgent = await svc.create(companyId, {
      id: agentId,
      ...createInput,
      adapterConfig: normalizedAdapterConfig,
      runtimeConfig: normalizedRuntimeConfig,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent, instructionsBundle);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackAgentCreated(telemetryClient, { agentRole: agent.role, agentId: agent.id });
    }

    await applyDefaultAgentTaskAssignGrant(
      companyId,
      agent.id,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );
    await builtInAgentService(db).ensureCompanyDefaultAgentGrants(companyId);

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        companyId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    res.status(201).json(agent);
  });

  // Office avatar: stored in agent.metadata.officeAvatarUrl (no schema change).
  // Anyone who can update the agent (its manager/owner/admin) may set it.
  router.put("/agents/:id/office-avatar", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    // Only accept our own asset content paths (or clear with empty string).
    if (url && !/^\/api\/assets\/[\w-]+\/content/.test(url)) {
      res.status(400).json({ error: "url must be an uploaded asset content path" });
      return;
    }
    const nextMetadata = { ...(existing.metadata ?? {}) } as Record<string, unknown>;
    if (url) nextMetadata.officeAvatarUrl = url;
    else delete nextMetadata.officeAvatarUrl;
    const updated = await svc.update(id, { metadata: nextMetadata });
    res.json(updated);
  });

  // Office character: which catalog look the agent uses on the Virtual Office
  // floor. Stored in agent.metadata.officeCharacterId (a slug like "cat" / "male").
  // Empty string clears it back to the gender default. No schema change.
  router.put("/agents/:id/office-character", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    // Slug-only (folder-name safe); empty clears.
    if (characterId && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(characterId)) {
      res.status(400).json({ error: "characterId must be a lowercase slug" });
      return;
    }
    const nextMetadata = { ...(existing.metadata ?? {}) } as Record<string, unknown>;
    if (characterId) nextMetadata.officeCharacterId = characterId;
    else delete nextMetadata.officeCharacterId;
    const updated = await svc.update(id, { metadata: nextMetadata });
    res.json(updated);
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;

    if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.companyId !== existing.companyId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (actorAgent.role !== "ceo") {
        res.status(403).json({ error: "Only CEO can manage permissions" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, existing.companyId);
    }

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const effectiveCanAssignTasks =
      agent.role === "ceo" || Boolean(agent.permissions?.canCreateAgents) || req.body.canAssignTasks;
    await access.ensureMembership(agent.companyId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.companyId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canCreateSkills: agent.permissions?.canCreateSkills ?? true,
        canAssignTasks: effectiveCanAssignTasks,
        trustPreset: agent.permissions?.trustPreset ?? "standard",
      },
    });

    res.json(await buildAgentDetail(agent));
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    if (req.actor.type !== "board") {
      throw forbidden("Only board-authenticated callers can manage instructions path or bundle configuration");
    }

    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.adapterConfigKey);
    const defaultKey = resolveInstructionsPathKey(existing.adapterType);
    const adapterConfigKey = explicitKey ?? defaultKey;
    if (!adapterConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.adapterType}'. Provide adapterConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[adapterConfigKey];
    } else {
      nextAdapterConfig[adapterConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[adapterConfigKey]);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        adapterConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      adapterType: agent.adapterType,
      adapterConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanReadAgent(req, existing);
    res.json(await instructions.getBundle(existing));
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const { bundle, adapterConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      adapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    res.json(await instructions.readFile(existing, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.companyId,
      result.adapterConfig,
      { strictMode: strictSecretsMode, adapterType: existing.adapterType },
    );
    await svc.update(
      id,
      { adapterConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;
    await assertCanManageInstructionsPath(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!existing) return;

    if (hasOwn(req.body as object, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }

    const patchData = { ...(req.body as Record<string, unknown>) };
    const replaceAdapterConfig = patchData.replaceAdapterConfig === true;
    delete patchData.replaceAdapterConfig;
    if (hasOwn(patchData, "adapterConfig")) {
      const adapterConfig = asRecord(patchData.adapterConfig);
      if (!adapterConfig) {
        res.status(422).json({ error: "adapterConfig must be an object" });
        return;
      }
      assertNoAgentAdapterConfigMutation(req, adapterConfig);
      const changingInstructionsConfig = adapterConfigTouchesInstructionsConfig(adapterConfig);
      if (changingInstructionsConfig) {
        await assertCanManageInstructionsPath(req, existing);
      }
      patchData.adapterConfig = adapterConfig;
    }

    const requestedAdapterType = hasOwn(patchData, "adapterType")
      ? assertKnownAdapterType(patchData.adapterType as string | null | undefined)
      : existing.adapterType;
    let requestedRuntimeConfig: Record<string, unknown> | null = null;
    if (hasOwn(patchData, "runtimeConfig")) {
      const runtimeConfig = asRecord(patchData.runtimeConfig);
      if (!runtimeConfig) {
        res.status(422).json({ error: "runtimeConfig must be an object" });
        return;
      }
      assertNoAgentRuntimeConfigAdapterConfigMutation(req, runtimeConfig);
      requestedRuntimeConfig = runtimeConfig;
    }
    const touchesAdapterConfiguration =
      hasOwn(patchData, "adapterType") ||
      hasOwn(patchData, "adapterConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.adapterConfig) ?? {};
      const changingAdapterType =
        typeof patchData.adapterType === "string" && patchData.adapterType !== existing.adapterType;
      const requestedAdapterConfig = hasOwn(patchData, "adapterConfig")
        ? (asRecord(patchData.adapterConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAdapterConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAdapterConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        // Preserve adapter-agnostic keys (env, cwd, etc.) from the existing config
        // when the adapter type changes. Without this, a PATCH that includes
        // adapterConfig but omits these keys would silently drop them.
        for (const key of ADAPTER_AGNOSTIC_KEYS) {
          if (KNOWN_INSTRUCTIONS_BUNDLE_KEY_SET.has(key)) continue;
          if (rawEffectiveAdapterConfig[key] === undefined && existingAdapterConfig[key] !== undefined) {
            rawEffectiveAdapterConfig = { ...rawEffectiveAdapterConfig, [key]: existingAdapterConfig[key] };
          }
        }
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCodexLocalKeyIsolation(
        existing.companyId,
        existing.id,
        requestedAdapterType,
        applyCreateDefaultsByAdapterType(
          requestedAdapterType,
          rawEffectiveAdapterConfig,
        ),
      );
      const normalizedEffectiveAdapterConfig = await normalizeMediatedAdapterConfigForPersistence({
        companyId: existing.companyId,
        adapterType: requestedAdapterType,
        adapterConfig: effectiveAdapterConfig,
      });
      patchData.adapterConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (requestedRuntimeConfig) {
      const baseAdapterConfig = asRecord(patchData.adapterConfig) ?? asRecord(existing.adapterConfig) ?? {};
      patchData.runtimeConfig = await normalizeRuntimeConfigAdapterConfigsForPersistence(
        existing.companyId,
        requestedAdapterType,
        requestedRuntimeConfig,
        baseAdapterConfig,
      );
    }
    if (touchesAdapterConfiguration || Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")) {
      await assertAgentDefaultEnvironmentSelection(
        existing.companyId,
        Object.prototype.hasOwnProperty.call(patchData, "defaultEnvironmentId")
          ? (typeof patchData.defaultEnvironmentId === "string" ? patchData.defaultEnvironmentId : null)
          : existing.defaultEnvironmentId,
        {
          allowedDrivers: allowedEnvironmentDriversForAgent(requestedAdapterType),
          allowedSandboxProviders: allowedSandboxProvidersForAgent(requestedAdapterType),
        },
      );
    }
    const touchesProfileFields = touchesAgentProfileChangeConsentFields(patchData);
    const profileOnlyChange = touchesProfileFields && Object.keys(patchData).every((key) =>
      (AGENT_PROFILE_CHANGE_CONSENT_FIELDS as readonly string[]).includes(key),
    );
    if (profileOnlyChange) {
      await assertCanApplyAgentProfileChange(req, existing);
    } else {
      await assertCanUpdateAgent(req, existing);
    }

    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    res.json(agent);
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: existing.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before resuming it",
      });
      return;
    }
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/clear-error", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: existing.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before clearing its error",
      });
      return;
    }

    const agent = await svc.clearError(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/approve", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }
    if (existing.status !== "pending_approval") {
      res.status(409).json({ error: "Only pending approval agents can be approved" });
      return;
    }

    // Resolve the linked hire approval (clears it from the inbox) and run the
    // shared approval side effects: agent activation, budget policy, and the
    // hire-approved notification. Fall back to direct activation if no open
    // approval record exists (e.g. agents created before approvals were tracked).
    const decidedByUserId = req.actor.userId ?? "board";
    const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);

    let agent: Awaited<ReturnType<typeof svc.getById>> | null = null;
    if (openApproval) {
      await approvalsSvc.approve(openApproval.id, decidedByUserId);
      agent = await svc.getById(id);
    } else {
      const approval = await svc.activatePendingApproval(id);
      if (!approval) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!approval.activated) {
        res.status(409).json({ error: "Only pending approval agents can be approved" });
        return;
      }
      agent = approval.agent;
    }

    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.approved",
      entityType: "agent",
      entityId: agent.id,
      details: { source: "agent_detail", approvalId: openApproval?.id ?? null },
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleAgent(req, res, id);
    if (!existing) {
      return;
    }

    // Terminating an agent that is still awaiting approval is the agent-detail
    // equivalent of rejecting the hire. When a linked hire approval is still
    // open, delegate to approvalsSvc.reject(), which both resolves the approval
    // (clearing the inbox "Approve/Reject" card) and terminates the agent.
    // Mirror the approve path's branch-or-fallback so we never terminate twice:
    // reject() already calls agentsSvc.terminate() internally.
    let agent: Awaited<ReturnType<typeof svc.terminate>> = null;
    if (existing.status === "pending_approval") {
      const openApproval = await approvalsSvc.findOpenHireApprovalForAgent(existing.companyId, id);
      if (openApproval) {
        await approvalsSvc.reject(openApproval.id, req.actor.userId ?? "board");
        agent = await svc.getById(id);
      }
    }
    if (!agent) {
      agent = await svc.terminate(id);
    }
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const companyAgentRows = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        reportsTo: agentsTable.reportsTo,
        status: agentsTable.status,
      })
      .from(agentsTable)
      .where(eq(agentsTable.companyId, agent.companyId));
    const invalidOrgChainDescendantIds = listInvalidOrgChainDescendantIds(id, companyAgentRows);
    const cancellation = await heartbeat.cancelInvocationsForAgents(
      [id, ...invalidOrgChainDescendantIds],
      "Cancelled because the agent was terminated or became invalid-org-chain under a terminated manager",
    );

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        invalidOrgChain: {
          descendantCount: invalidOrgChainDescendantIds.length,
          descendantIds: invalidOrgChainDescendantIds,
          state: invalidOrgChainDescendantIds.length > 0 ? "descendants_invalid_under_terminated_manager" : "none",
        },
        cancellation: {
          agentIds: cancellation.agentIds,
          runsCancelled: cancellation.runsCancelled,
          wakeupsCancelled: cancellation.wakeupsCancelled,
        },
      },
    });

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await getAccessibleAgent(req, res, id))) {
      return;
    }
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }
    const key = await svc.createApiKey(id, req.body.name, req.body.scope, {
      responsibleUserId: req.actor.userId ?? null,
    });

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        keyId: key.id,
        name: key.name,
        scope: key.scope,
        responsibleUserId: key.responsibleUserId,
      },
    });

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keyId = req.params.keyId as string;
    const agent = await getAccessibleAgent(req, res, id);
    if (!agent) {
      return;
    }

    const key = await svc.getKeyById(keyId);
    if (!key || key.agentId !== agent.id) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    const revoked = await svc.revokeKey(agent.id, keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.key_revoked",
      entityType: "agent",
      entityId: agent.id,
      details: { keyId: key.id, name: key.name },
    });

    res.json({ ok: true });
  });

  // Shared handler body for the wakeup-style endpoints. The two routes differ
  // only in:
  //  - `source` — the modern /wakeup endpoint reads it from the request body
  //    (timer|assignment|on_demand|automation) while the legacy
  //    /heartbeat/invoke endpoint hardcodes "on_demand", since it has only
  //    ever produced on-demand invocations.
  //  - skipped-response shape — the modern endpoint surfaces the rich
  //    SkippedWakeupResponse; the legacy endpoint stays on the simpler
  //    { status: "skipped" } shape for backward compat.
  type HeartbeatSource = "timer" | "assignment" | "on_demand" | "automation";
  type WakeupRouteOpts = {
    source: HeartbeatSource | undefined;
    skippedResponse: (agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) => unknown | Promise<unknown>;
  };
  const handleWakeupRoute = async (
    req: Request,
    res: Response,
    opts: WakeupRouteOpts,
  ): Promise<void> => {
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    if (agent.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: agent.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before starting runs",
      });
      return;
    }

    const run = await heartbeat.wakeup(id, {
      source: opts.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json(await opts.skippedResponse(agent));
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: run.id,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  };

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    await handleWakeupRoute(req, res, {
      source: req.body.source,
      skippedResponse: (agent) => buildSkippedWakeupResponse(agent, req.body.payload ?? null),
    });
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    // Legacy endpoint. Hardcodes `source: "on_demand"` (the prior behavior
    // before the wakeup/invoke convergence). Reads scope fields directly off
    // the body without `validate(wakeAgentSchema)` because callers — including
    // the e2e suite — post an empty body, and the schema rejects undefined
    // / missing bodies. Only forwards fields the caller actually supplied so
    // an empty body produces the original fixed-arg `heartbeat.invoke()`
    // shape exactly.
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== id) {
        res.status(403).json({ error: "Agent can only invoke itself" });
        return;
      }
    } else {
      await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    }
    if (agent.orgChainHealth?.status === "invalid_org_chain") {
      res.status(409).json({
        error: agent.orgChainHealth?.repairGuidance ?? "Repair this agent's reporting chain before starting runs",
      });
      return;
    }

    const body = (req.body ?? {}) as Partial<{
      reason: unknown;
      payload: unknown;
      idempotencyKey: unknown;
      forceFreshSession: unknown;
      triggerDetail: unknown;
    }>;
    const contextSnapshot: Record<string, unknown> = {
      triggeredBy: req.actor.type,
      actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
    };
    if (body.forceFreshSession === true) {
      contextSnapshot.forceFreshSession = true;
    }
    const wakeOpts: Parameters<typeof heartbeat.wakeup>[1] = {
      source: "on_demand",
      triggerDetail: typeof body.triggerDetail === "string" ? body.triggerDetail as "manual" | "system" | "ping" | "callback" : "manual",
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot,
    };
    if (typeof body.reason === "string" && body.reason.length > 0) {
      wakeOpts.reason = body.reason;
    }
    if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
      wakeOpts.payload = body.payload as Record<string, unknown>;
    }
    if (typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0) {
      wakeOpts.idempotencyKey = body.idempotencyKey;
    }
    const run = await heartbeat.wakeup(id, wakeOpts);

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: run.id,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;
    await assertBoardCanManageAgentsForCompany(req, agent.companyId);
    if (agent.adapterType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.adapterConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.companyId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterType: agent.adapterType,
        adapterConfig: agent.adapterConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/companies/:companyId/heartbeat-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const summary = req.query.summary === "true" || req.query.summary === "1";
    const runs = await heartbeat.list(companyId, agentId, limit, { summary });
    res.json(runs);
  });

  router.get("/companies/:companyId/live-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // `minCount` is a padding floor for callers that want a minimum number of
    // recent runs to render (e.g. dashboard cards). It must default to 0 so
    // callers asking for "live runs" get only actually-live runs — otherwise
    // every caller with no minCount param gets up to 50 historical runs
    // padded in and renders bogus "live" counts.
    const minCount = readLiveRunsQueryInt(req.query.minCount, 50, 0);
    const limit = readLiveRunsQueryInt(req.query.limit, 50, 50);

    // Restricted members only see live runs for agents they've joined. An empty
    // scope (no joined agents) uses a sentinel so the query matches nothing.
    let restrictedAgentScope: string[] | null = null;
    if (!isPrivilegedAgentViewer(req, companyId) && req.actor.type === "board" && req.actor.userId) {
      const joined = await visibleAgentIds(companyId, req.actor.userId);
      restrictedAgentScope = joined.size > 0 ? [...joined] : ["__none__"];
    }
    const restrictedScopeCondition = restrictedAgentScope
      ? [inArray(heartbeatRuns.agentId, restrictedAgentScope)]
      : [];

    const columns = {
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
      contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      adapterType: agentsTable.adapterType,
      logBytes: heartbeatRuns.logBytes,
      livenessState: heartbeatRuns.livenessState,
      livenessReason: heartbeatRuns.livenessReason,
      continuationAttempt: heartbeatRuns.continuationAttempt,
      lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      nextAction: heartbeatRuns.nextAction,
      lastOutputAt: heartbeatRuns.lastOutputAt,
      lastOutputSeq: heartbeatRuns.lastOutputSeq,
      lastOutputStream: heartbeatRuns.lastOutputStream,
      lastOutputBytes: heartbeatRuns.lastOutputBytes,
      processStartedAt: heartbeatRuns.processStartedAt,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRunsQuery = db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          ...restrictedScopeCondition,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const liveRuns = await liveRunsQuery.limit(limit);
    const targetRunCount = Math.min(minCount, limit);

    if (targetRunCount > 0 && liveRuns.length < targetRunCount) {
      const activeIds = liveRuns.map((r) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
            ...restrictedScopeCondition,
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(targetRunCount - liveRuns.length);

      const rows = [...liveRuns, ...recentRuns];
      res.json(await Promise.all(rows.map(async (run) => ({
        ...heartbeat.decorateActiveRunStatus(run),
        outputSilence: await heartbeat.buildRunOutputSilence(run),
      }))));
      return;
    }

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...heartbeat.decorateActiveRunStatus(run),
      outputSilence: await heartbeat.buildRunOutputSilence(run),
    }))));
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
    if (!run) return;
    const retryExhaustedReason = await heartbeat.getRetryExhaustedReason(runId);
    const decoratedRun = heartbeat.decorateActiveRunStatus(run);
    res.json(
      redactCurrentUserValue(
        { ...decoratedRun, retryExhaustedReason, outputSilence: await heartbeat.buildRunOutputSilence(run) },
        await getCurrentUserRedactionOptions(),
      ),
    );
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const existing = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
    if (!existing) return;
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        companyId: run.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.post("/heartbeat-runs/:runId/watchdog-decisions", async (req, res) => {
    const runId = req.params.runId as string;
    const existing = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
    if (!existing) return;
    const decision = typeof req.body?.decision === "string" ? req.body.decision : "";
    if (!["snooze", "continue", "dismissed_false_positive"].includes(decision)) {
      res.status(400).json({ error: "Unsupported watchdog decision" });
      return;
    }
    const evaluationIssueId = typeof req.body?.evaluationIssueId === "string" ? req.body.evaluationIssueId : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 4000) : null;
    const snoozedUntil = decision === "snooze"
      ? new Date(String(req.body?.snoozedUntil ?? ""))
      : null;
    if (decision === "snooze" && (!snoozedUntil || Number.isNaN(snoozedUntil.getTime()) || snoozedUntil <= new Date())) {
      res.status(400).json({ error: "snoozedUntil must be a future ISO datetime" });
      return;
    }

    const row = await recovery.recordWatchdogDecision({
      runId: existing.id,
      actor: req.actor,
      decision: decision as "snooze" | "continue" | "dismissed_false_positive",
      evaluationIssueId,
      reason,
      snoozedUntil,
      createdByRunId: req.actor.runId ?? null,
    });

    res.json(row);
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
    if (!run) return;

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getAccessibleResource(req, res, heartbeat.getRunLogAccess(runId), "Heartbeat run not found");
    if (!run) return;

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    const result = await heartbeat.readLog(run, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getAccessibleResource(req, res, heartbeat.getRun(runId), "Heartbeat run not found");
    if (!run) return;

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await getAccessibleResource(req, res, workspaceOperations.getById(operationId), "Workspace operation not found");
    if (!operation) return;

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = readRunLogLimitBytes(req.query.limitBytes);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes,
    });

    res.set("Cache-Control", "no-cache, no-store");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const identifier = normalizeIssueIdentifier(rawId);
    const issue = await getAccessibleResource(
      req,
      res,
      identifier ? issueSvc.getByIdentifier(identifier) : issueSvc.getById(rawId),
      "Issue not found",
    );
    if (!issue) return;

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'commentId'`.as("contextCommentId"),
        contextWakeCommentId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId'`.as("contextWakeCommentId"),
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
        logBytes: heartbeatRuns.logBytes,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        nextAction: heartbeatRuns.nextAction,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastOutputSeq: heartbeatRuns.lastOutputSeq,
        lastOutputStream: heartbeatRuns.lastOutputStream,
        lastOutputBytes: heartbeatRuns.lastOutputBytes,
        processStartedAt: heartbeatRuns.processStartedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(await Promise.all(liveRuns.map(async (run) => ({
      ...heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id }),
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    }))));
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const identifier = normalizeIssueIdentifier(rawId);
    const issue = await getAccessibleResource(
      req,
      res,
      identifier ? issueSvc.getByIdentifier(identifier) : issueSvc.getById(rawId),
      "Issue not found",
    );
    if (!issue) return;

    let run = issue.executionRunId ? await heartbeat.getRunIssueSummary(issue.executionRunId) : null;
    if (
      run &&
      (
        (run.status !== "queued" && run.status !== "running") ||
        run.issueId !== issue.id
      )
    ) {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunIssueSummaryForAgent(issue.assigneeAgentId);
      const candidateIssueId = asNonEmptyString(candidateRun?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    const decoratedRun = heartbeat.decorateActiveRunStatus(run, { companyId: issue.companyId, issueId: issue.id });
    res.json({
      ...decoratedRun,
      agentId: agent.id,
      agentName: agent.name,
      adapterType: agent.adapterType,
      outputSilence: await heartbeat.buildRunOutputSilence({ ...run, companyId: issue.companyId }),
    });
  });

  return router;
}
