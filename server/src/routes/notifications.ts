import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { notificationService } from "../services/notifications.js";
import { summaryService } from "../services/summaries.js";
import { assertCompanyAccess } from "./authz.js";

export function notificationRoutes(db: Db) {
  const router = Router();
  const svc = notificationService(db);
  const summaries = summaryService(db);
  const callerUserId = (req: { actor: { type: string; userId?: string } }): string | null =>
    req.actor.type === "board" ? req.actor.userId ?? null : null;

  router.get("/companies/:companyId/notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const uid = callerUserId(req);
    if (!uid) {
      res.json({ notifications: [], unread: 0 });
      return;
    }
    const [rows, unread] = await Promise.all([svc.listForUser(companyId, uid), svc.unreadCount(companyId, uid)]);
    res.json({ notifications: rows, unread });
  });

  router.post("/companies/:companyId/notifications/:id/read", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const uid = callerUserId(req);
    if (!uid) {
      res.status(403).json({ error: "No user context." });
      return;
    }
    await svc.markRead(companyId, uid, req.params.id as string);
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/notifications/read-all", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const uid = callerUserId(req);
    if (!uid) {
      res.status(403).json({ error: "No user context." });
      return;
    }
    await svc.markAllRead(companyId, uid);
    res.json({ ok: true });
  });

  // Manual trigger (board-only) to generate the weekly summary on demand — for
  // testing without waiting for the scheduled Friday window. Idempotent.
  // (Daily summaries were removed to save tokens; weekly only.)
  router.post("/companies/:companyId/summaries/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board only." });
      return;
    }
    const created = await summaries.generate(companyId, "weekly", new Date());
    res.json({ ok: true, kind: "weekly", created });
  });

  return router;
}
