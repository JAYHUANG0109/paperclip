import express, { Router, type Request as ExpressRequest } from "express";
import compression from "compression";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { applyTrustProxy, parseTrustProxyEnv } from "./middleware/trust-proxy.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { bountyRoutes } from "./routes/bounties.js";
import { leaderboardService } from "./services/leaderboard.js";
import { summaryService } from "./services/summaries.js";
import { notificationService } from "./services/notifications.js";
import { teamsCatalogRoutes } from "./routes/teams-catalog.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { fileResourceRoutes } from "./routes/file-resources.js";
import { routineRoutes } from "./routes/routines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { boardChatRoutes } from "./routes/board-chat.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { notificationRoutes } from "./routes/notifications.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { openApiRoutes } from "./routes/openapi.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { authRoutes } from "./routes/auth.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { wikiRoutes } from "./routes/wiki.js";
import { distillCompanyWiki } from "./services/wiki-distillation.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { buildHostServices, flushPluginLogBuffer } from "./services/plugin-host-services.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { setPluginEventBus } from "./services/activity-log.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createHostClientHandlers } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";
import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./http/body-limits.js";
import { COMPANY_IMPORT_API_PATH } from "./routes/company-import-paths.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-96x96.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function isDatabaseConnectionUnavailableError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (error?.code === "ECONNREFUSED") return true;
  return Boolean(error?.cause && isDatabaseConnectionUnavailableError(error.cause));
}

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::") return undefined;
  return bindHost;
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export function shouldEnablePrivateHostnameGuard(opts: {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
}): boolean {
  return (
    opts.deploymentExposure === "private" &&
    (opts.deploymentMode === "local_trusted" || opts.deploymentMode === "authenticated")
  );
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    databaseBackupService?: InstanceDatabaseBackupService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    restrictAgentVisibility?: boolean;
    googleAuthEnabled?: boolean;
    instanceId?: string;
    hostVersion?: string;
    localPluginDir?: string;
    pluginMigrationDb?: Db;
    pluginWorkerManager?: PluginWorkerManager;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    wikiRoot?: string;
    wikiDistillEnabled?: boolean;
    wikiDistillCompanyId?: string;
    wikiDistillIntervalMs?: number;
  },
) {
  const app = express();

  // Gzip responses. Without this the server sent the ~14 MB JS bundle uncompressed,
  // which timed out on phones / slower links behind the Tailscale funnel ("load failed").
  // Skip text/event-stream so SSE (board-chat, plugin streams) keeps flushing live.
  app.use(
    compression({
      filter: (req, res) => {
        const contentType = String(res.getHeader("Content-Type") ?? "");
        if (contentType.includes("text/event-stream")) return false;
        return compression.filter(req, res);
      },
    }),
  );

  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  // Respect the operator's `TRUST_PROXY` env var (see middleware/trust-proxy.ts).
  // Default is unset → Express trusts nothing, which is the only safe choice
  // when the server may be reachable without a known reverse proxy in front.
  applyTrustProxy(app, parseTrustProxyEnv(process.env.TRUST_PROXY));

  app.use(COMPANY_IMPORT_API_PATH, express.json({
    limit: PORTABLE_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({
    limit: DEFAULT_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(httpLogger);
  const privateHostnameGateEnabled = shouldEnablePrivateHostnameGuard({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.use("/api/auth", authRoutes(db));
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = opts.pluginWorkerManager ?? createPluginWorkerManager();

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      googleAuthEnabled: opts.googleAuthEnabled,
    }),
  );
  api.use(openApiRoutes());
  api.use("/companies", companyRoutes(db, opts.storageService));
  api.use(llmRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(bountyRoutes(db));
  api.use(teamsCatalogRoutes(db));
  api.use(agentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  const restrictVisibility = opts.restrictAgentVisibility;
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
  }));
  api.use(issueTreeControlRoutes(db));
  api.use(fileResourceRoutes(db));
  api.use(routineRoutes(db, { pluginWorkerManager: workerManager, restrictVisibility }));
  api.use(environmentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(executionWorkspaceRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(goalRoutes(db, { restrictVisibility }));
  api.use(boardChatRoutes(db, { deploymentMode: opts.deploymentMode }));
  api.use(approvalRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(secretRoutes(db));
  api.use(costRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(activityRoutes(db, { restrictVisibility }));
  api.use(dashboardRoutes(db, { restrictVisibility }));
  api.use(notificationRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(resourceMembershipRoutes(db));
  api.use(wikiRoutes(db, { wikiRoot: opts.wikiRoot }));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  if (opts.databaseBackupService) {
    api.use(instanceDatabaseBackupRoutes(opts.databaseBackupService));
  }
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  const loader = pluginLoader(
    db,
    {
      localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
      migrationDb: opts.pluginMigrationDb,
    },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, {
          pluginWorkerManager: workerManager,
          manifest,
          storageService: opts.storageService,
        });
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );
  api.use(
    pluginRoutes(
      db,
      loader,
      { scheduler, jobStore },
      { workerManager },
      { toolDispatcher },
      { workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
  }));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively.
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(readBrandedStaticIndexHtml(uiDist));
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const hmrHost = resolveViteHmrHost(opts.bindHost);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          ...(hmrHost ? { host: hmrHost } : {}),
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  jobCoordinator.start();
  scheduler.start();
  let feedbackExportShuttingDown = false;
  let feedbackExportTimer: ReturnType<typeof setInterval> | null = null;
  const disableFeedbackExportFlushes = () => {
    feedbackExportShuttingDown = true;
    if (feedbackExportTimer) {
      clearInterval(feedbackExportTimer);
      feedbackExportTimer = null;
    }
  };
  const flushPendingFeedbackExports = async () => {
    if (feedbackExportShuttingDown) return;
    try {
      await opts.feedbackExportService?.flushPendingFeedbackTraces();
    } catch (err) {
      if (isDatabaseConnectionUnavailableError(err)) {
        disableFeedbackExportFlushes();
        logger.warn({ err }, "Disabling pending feedback export flushes because the database is unavailable");
        return;
      }
      logger.error({ err }, "Failed to flush pending feedback exports");
    }
  };

  feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void flushPendingFeedbackExports();
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void flushPendingFeedbackExports();
  }

  // Phase 8: daily server-side wiki distillation (route B2). Deterministic,
  // no LLM — bypasses the claude-local Wiki Maintainer limitation.
  let wikiDistillTimer: ReturnType<typeof setInterval> | null = null;
  const runWikiDistillation = async () => {
    const wikiRoot = opts.wikiRoot;
    if (!wikiRoot) return;
    try {
      let companyIds: string[];
      if (opts.wikiDistillCompanyId) {
        companyIds = [opts.wikiDistillCompanyId];
      } else {
        const rows = await db.select({ id: companies.id }).from(companies);
        companyIds = rows.map((r) => r.id);
      }
      for (const companyId of companyIds) {
        const result = await distillCompanyWiki({ db, companyId, wikiRoot });
        logger.info({ companyId, ...result }, "wiki distillation pass complete");
      }
    } catch (err) {
      logger.error({ err }, "scheduled wiki distillation failed");
    }
  };
  if (opts.wikiDistillEnabled && opts.wikiRoot) {
    wikiDistillTimer = setInterval(() => {
      void runWikiDistillation();
    }, opts.wikiDistillIntervalMs ?? 24 * 60 * 60 * 1000);
    wikiDistillTimer.unref?.();
    void runWikiDistillation();
  }

  // Monthly leaderboard rollup: a daily idempotent check that freezes the
  // PREVIOUS completed month's award winners for every company. Re-running is
  // safe (upsert), so a daily cadence reliably catches the month boundary.
  let monthlyRollupTimer: ReturnType<typeof setInterval> | null = null;
  const previousMonthKey = (now: Date): string => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };
  const runMonthlyRollups = async () => {
    try {
      const leaderboard = leaderboardService(db);
      const period = previousMonthKey(new Date());
      const rows = await db.select({ id: companies.id }).from(companies);
      for (const c of rows) {
        await leaderboard.runMonthlyRollup(c.id, period);
      }
      logger.info({ period, companies: rows.length }, "monthly leaderboard rollup complete");
      try {
        const pruned = await notificationService(db).pruneOlderThan(90);
        if (pruned > 0) logger.info({ pruned }, "pruned notifications older than 90d");
      } catch (pruneErr) {
        logger.warn({ err: pruneErr }, "notification prune failed");
      }
    } catch (err) {
      logger.error({ err }, "scheduled monthly rollup failed");
    }
  };
  monthlyRollupTimer = setInterval(() => { void runMonthlyRollups(); }, 24 * 60 * 60 * 1000);
  monthlyRollupTimer.unref?.();
  void runMonthlyRollups();

  // "Tasks done" summaries → each user's inbox. Daily after ~17:30 and weekly
  // (Fri) after ~17:45 Asia/Taipei. A ~5-min idempotent tick: once the local
  // time passes the threshold the per-user summary is created exactly once
  // (notification dedupeKey guards re-runs), so this is safe to re-run/restart.
  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  const runDueSummaries = async () => {
    try {
      const summaries = summaryService(db);
      const now = new Date();
      const tp = new Date(now.getTime() + 8 * 60 * 60 * 1000); // Asia/Taipei (UTC+8, no DST)
      const hour = tp.getUTCHours();
      const minute = tp.getUTCMinutes();
      const weekday = tp.getUTCDay(); // 0=Sun .. 6=Sat
      const pastDaily = hour > 17 || (hour === 17 && minute >= 30);
      const pastWeekly =
        (weekday === 5 && (hour > 17 || (hour === 17 && minute >= 45))) ||
        weekday === 6 ||
        weekday === 0; // Fri 17:45 onward, plus weekend catch-up (same week, deduped)
      if (!pastDaily && !pastWeekly) return;
      const rows = await db.select({ id: companies.id }).from(companies);
      for (const c of rows) {
        if (pastDaily) await summaries.generate(c.id, "daily", now);
        if (pastWeekly) await summaries.generate(c.id, "weekly", now);
      }
    } catch (err) {
      logger.warn({ err }, "scheduled summaries tick failed");
    }
  };
  summaryTimer = setInterval(() => { void runDueSummaries(); }, 5 * 60 * 1000);
  summaryTimer.unref?.();
  void runDueSummaries();
  void toolDispatcher.initialize().catch((err) => {
    logger.error({ err }, "Failed to initialize plugin tool dispatcher");
  });
  const devWatcher = createPluginDevWatcher(
    lifecycle,
    async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
  );
  // Auto-install the bundled kubernetes sandbox-provider plugin so the
  // "kubernetes" sandbox provider is registered for agent runs. The plugin is
  // excluded from the pnpm workspace and built standalone into the image (see
  // Dockerfile), then installed here from its local path. This runs BEFORE
  // loadAll() so loadAll() can activate it in the same startup pass.
  //
  // SAFETY (invariant B): this is fully fail-safe. Any failure (missing path,
  // install error, load error) is caught, logged, and swallowed so the server
  // ALWAYS finishes booting. A degraded boot (no kubernetes provider, agents
  // cannot run) is strictly preferable to a crash loop.
  const ensureBundledKubernetesPlugin = async (): Promise<void> => {
    const KUBERNETES_PLUGIN_KEY = "paperclip.kubernetes-sandbox-provider";
    const pluginPath =
      process.env["PAPERCLIP_KUBERNETES_PLUGIN_PATH"] ??
      "/app/packages/plugins/sandbox-providers/kubernetes";
    try {
      // Idempotent: skip if already installed (any non-uninstalled status).
      const existing = await pluginRegistry.getByKey(KUBERNETES_PLUGIN_KEY);
      if (existing) {
        logger.info(
          { pluginKey: KUBERNETES_PLUGIN_KEY, status: existing.status },
          "kubernetes sandbox plugin already installed; skipping auto-install",
        );
        return;
      }
      // Skip silently when the bundle is absent (e.g. local dev or an image
      // built without the plugin). Not an error condition.
      if (!fs.existsSync(path.join(pluginPath, "dist", "manifest.js"))) {
        logger.info(
          { pluginPath },
          "kubernetes sandbox plugin bundle not present; skipping auto-install",
        );
        return;
      }
      logger.info({ pluginPath }, "auto-installing bundled kubernetes sandbox plugin");
      const discovered = await loader.installPlugin({ localPath: pluginPath });
      if (!discovered.manifest) {
        logger.error("kubernetes sandbox plugin installed but manifest is missing");
        return;
      }
      // Transition installed -> ready and activate the worker.
      const installed = await pluginRegistry.getByKey(discovered.manifest.id);
      if (installed) {
        await lifecycle.load(installed.id);
        logger.info(
          { pluginId: installed.id, pluginKey: installed.pluginKey },
          "kubernetes sandbox plugin auto-installed and loaded",
        );
      } else {
        logger.error("kubernetes sandbox plugin installed but not found in registry");
      }
    } catch (err) {
      logger.error(
        { err },
        "Failed to auto-install the kubernetes sandbox plugin; continuing boot (degraded: kubernetes provider unavailable)",
      );
    }
  };
  void ensureBundledKubernetesPlugin()
    .then(() => loader.loadAll())
    .then((result) => {
    if (!result) return;
    for (const loaded of result.results) {
      if (devWatcher && loaded.success && loaded.plugin.packagePath) {
        devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
      }
    }
  }).catch((err) => {
    logger.error({ err }, "Failed to load ready plugins on startup");
  });
  let appServicesShutdown = false;
  const shutdownAppServices = () => {
    if (appServicesShutdown) return;
    appServicesShutdown = true;
    disableFeedbackExportFlushes();
    if (wikiDistillTimer) {
      clearInterval(wikiDistillTimer);
      wikiDistillTimer = null;
    }
    if (summaryTimer) {
      clearInterval(summaryTimer);
      summaryTimer = null;
    }
    devWatcher?.close();
    viteHtmlRenderer?.dispose();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  };
  app.locals.paperclipShutdown = shutdownAppServices;

  process.once("exit", shutdownAppServices);
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return app;
}
