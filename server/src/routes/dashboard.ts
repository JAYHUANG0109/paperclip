import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess, assertPrivilegedMemberView } from "./authz.js";

export function dashboardRoutes(db: Db, options: { restrictVisibility?: boolean } = {}) {
  const restrictVisibility = options.restrictVisibility ?? false;
  const router = Router();
  const svc = dashboardService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // The dashboard is an org-wide oversight view (all agents' activity, spend,
    // approvals). Restricted members (operator/viewer) are not allowed to see it.
    assertPrivilegedMemberView(req, companyId, restrictVisibility);
    const summary = await svc.summary(companyId);
    res.json(summary);
  });

  return router;
}
