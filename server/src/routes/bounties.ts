import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { bountyService } from "../services/bounties.js";

export function bountyRoutes(db: Db) {
  const router = Router();
  const svc = bountyService(db);

  async function resolveActorName(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const u = await db
      .select({ name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null);
    return u?.name ?? u?.email ?? null;
  }

  router.get("/companies/:companyId/bounties", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.post("/companies/:companyId/bounties", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) { res.status(400).json({ error: "title is required" }); return; }
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const row = await svc.create(companyId, {
      title,
      description: typeof body.description === "string" ? body.description : null,
      estimatedMinutes: typeof body.estimatedMinutes === "number" ? body.estimatedMinutes : 0,
      postedByUserId: userId,
      postedByName: await resolveActorName(userId),
    });
    res.status(201).json(row);
  });

  router.post("/companies/:companyId/bounties/:bountyId/claim", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bountyId = req.params.bountyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const row = await svc.claim(companyId, bountyId, userId, await resolveActorName(userId));
    if (!row) { res.status(409).json({ error: "Bounty already claimed or not found" }); return; }
    res.json(row);
  });

  router.post("/companies/:companyId/bounties/:bountyId/complete", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bountyId = req.params.bountyId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const linkedSkillId = typeof body.linkedSkillId === "string" ? body.linkedSkillId : null;
    const row = await svc.complete(companyId, bountyId, linkedSkillId);
    if (!row) { res.status(404).json({ error: "Bounty not found" }); return; }
    res.json(row);
  });

  router.delete("/companies/:companyId/bounties/:bountyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bountyId = req.params.bountyId as string;
    assertCompanyAccess(req, companyId);
    const row = await svc.remove(companyId, bountyId);
    if (!row) { res.status(404).json({ error: "Bounty not found" }); return; }
    res.json(row);
  });

  return router;
}
