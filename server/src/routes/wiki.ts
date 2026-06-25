import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginCompanySettings } from "@paperclipai/db";
import { assertCompanyAccess, isPrivilegedMemberViewer } from "./authz.js";
import { distillCompanyWiki } from "../services/wiki-distillation.js";
import { logger } from "../middleware/logger.js";

const WIKI_PLUGIN_KEY = "paperclipai.plugin-llm-wiki";
const WIKI_ROOT_FOLDER_KEY = "wiki-root";

/**
 * Resolve the wiki root for a company. Prefers the explicit server env
 * (PAPERCLIP_WIKI_ROOT) but falls back to the path the LLM-wiki plugin already
 * stores per company, so the on-demand route works without server env/restart.
 */
async function resolveWikiRoot(
  db: Db,
  companyId: string,
  envWikiRoot: string | undefined,
): Promise<string | null> {
  if (envWikiRoot) return envWikiRoot;
  const pluginRow = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, WIKI_PLUGIN_KEY))
    .then((rows) => rows[0] ?? null);
  if (!pluginRow) return null;
  const settingsRow = await db
    .select({ settingsJson: pluginCompanySettings.settingsJson })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, pluginRow.id),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const localFolders = (settingsRow?.settingsJson as Record<string, unknown> | undefined)?.localFolders as
    | Record<string, { path?: string }>
    | undefined;
  return localFolders?.[WIKI_ROOT_FOLDER_KEY]?.path ?? null;
}

/**
 * Phase 8 — on-demand wiki distillation.
 * POST /api/companies/:companyId/wiki/distill triggers a deterministic
 * server-side distill pass (route B2). Privileged members only.
 */
export function wikiRoutes(db: Db, opts: { wikiRoot: string | undefined }): Router {
  const router = Router();

  router.post("/companies/:companyId/wiki/distill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only company owners/admins can run wiki distillation" });
      return;
    }
    const wikiRoot = await resolveWikiRoot(db, companyId, opts.wikiRoot);
    if (!wikiRoot) {
      res.status(400).json({
        error:
          "Wiki root is not configured. Configure the LLM-wiki plugin's folder, or set PAPERCLIP_WIKI_ROOT.",
      });
      return;
    }
    try {
      const result = await distillCompanyWiki({ db, companyId, wikiRoot });
      res.json(result);
    } catch (err) {
      logger.error({ err, companyId }, "wiki distillation failed");
      res.status(500).json({ error: "Wiki distillation failed" });
    }
  });

  return router;
}
