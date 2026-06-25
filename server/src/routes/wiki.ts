import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess, isPrivilegedMemberViewer } from "./authz.js";
import { distillCompanyWiki } from "../services/wiki-distillation.js";
import { logger } from "../middleware/logger.js";

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
    if (!opts.wikiRoot) {
      res.status(400).json({
        error:
          "Wiki root is not configured. Set PAPERCLIP_WIKI_ROOT to the wiki folder path on the server.",
      });
      return;
    }
    try {
      const result = await distillCompanyWiki({ db, companyId, wikiRoot: opts.wikiRoot });
      res.json(result);
    } catch (err) {
      logger.error({ err, companyId }, "wiki distillation failed");
      res.status(500).json({ error: "Wiki distillation failed" });
    }
  });

  return router;
}
