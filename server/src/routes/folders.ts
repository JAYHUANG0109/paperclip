import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createFolderSchema,
  ensureMySkillFolderSchema,
  folderKindSchema,
  moveFolderItemSchema,
  moveFolderSchema,
  updateFolderSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, forbidden } from "../errors.js";
import { companySkillService, folderService, logActivity } from "../services/index.js";
import type { FolderViewer } from "../services/folders.js";
import { actorAllowsRestrictedFolders, assertCompanyAccess, getActorInfo, isPrivilegedMemberViewer } from "./authz.js";

export function folderRoutes(db: Db) {
  const router = Router();
  const svc = folderService(db);
  const skillSvc = companySkillService(db);

  function parseKind(value: unknown) {
    const result = folderKindSchema.safeParse(value);
    if (!result.success) throw badRequest("Folder kind query parameter is required");
    return result.data;
  }

  // Resolve who is asking so the service can scope-filter folders. Agents (and
  // non-board actors) get `undefined` = privileged (they resolve folders via
  // assignment, not the browse UI). Board users are filtered by scope +
  // membership + the founder numbered-folder allowlist.
  async function resolveViewer(req: Request, companyId: string): Promise<FolderViewer | undefined> {
    if (req.actor.type !== "board") return undefined;
    const isPrivileged = isPrivilegedMemberViewer(req, companyId, true);
    const userId = req.actor.userId ?? null;
    const allowRestrictedFolders = isPrivileged || await actorAllowsRestrictedFolders(req, db);
    const teams = userId && !isPrivileged ? Array.from(await skillSvc.getUserTeams(companyId, userId)) : [];
    return { userId, isPrivileged, allowRestrictedFolders, teams };
  }

  // Team-scoped folders may only target teams the caller is allowed to share to
  // (own teams, or ANY team for 資訊部 members / admins/owners). Mirrors the
  // company-skills routes so the folder tree can't be used to bypass the rule.
  async function assertSharingTeamsAllowed(req: Request, companyId: string, scope: unknown, sharingTeams: unknown): Promise<void> {
    if (scope !== "team") return;
    const requested = Array.isArray(sharingTeams)
      ? sharingTeams.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
      : [];
    if (requested.length === 0) return;
    const isPrivileged = isPrivilegedMemberViewer(req, companyId, true);
    const userId =
      req.actor.type === "board" ? req.actor.userId ?? null
      : req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null
      : null;
    const { teams: allowed, canShareToAll } = await skillSvc.getShareableTeams(companyId, userId, isPrivileged);
    if (canShareToAll) return;
    const foreign = requested.filter((t) => !allowed.has(t));
    if (foreign.length > 0) {
      throw forbidden(`You can only share to your own teams. Not permitted: ${foreign.join("、")}`);
    }
  }

  router.get("/companies/:companyId/folders", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId, parseKind(req.query.kind), await resolveViewer(req, companyId)));
  });

  router.post("/companies/:companyId/folders", validate(createFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSharingTeamsAllowed(req, companyId, req.body.scope, req.body.sharingTeams);
    const createdByUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const created = await svc.create(companyId, req.body, { createdByUserId });
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.created",
      entityType: "folder",
      entityId: created.id,
      details: { kind: created.kind, name: created.name, path: created.path, parentId: created.parentId, position: created.position },
    });
    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/folders/ensure-my",
    validate(ensureMySkillFolderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw forbidden("A signed-in board user is required to create a personal skill folder");
      }
      const folder = await svc.ensureMyFolder(companyId, req.actor.userId, req.actor.userName ?? null, req.body.slug);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "folder.personal_ensured",
        entityType: "folder",
        entityId: folder.id,
        details: { path: folder.path, systemKey: folder.systemKey },
      });
      res.json(folder);
    },
  );

  router.patch("/companies/:companyId/folders/:folderId", validate(updateFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    await assertSharingTeamsAllowed(req, companyId, req.body.scope, req.body.sharingTeams);
    const updated = await svc.update(companyId, folderId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
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
      action: "folder.updated",
      entityType: "folder",
      entityId: updated.id,
      details: { kind: updated.kind, name: updated.name, path: updated.path, position: updated.position },
    });
    res.json(updated);
  });

  router.post("/companies/:companyId/folders/items/move", validate(moveFolderItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const moved = await svc.moveItem(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "folder.item_moved",
      entityType: req.body.kind === "routine" ? "routine" : "company_skill",
      entityId: moved.itemId,
      details: { kind: moved.kind, folderId: moved.folderId },
    });
    res.json(moved);
  });

  router.post("/companies/:companyId/folders/:folderId/move", validate(moveFolderSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const updated = await svc.moveFolder(companyId, folderId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Folder not found" });
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
      action: "folder.moved",
      entityType: "folder",
      entityId: updated.id,
      details: { kind: updated.kind, parentId: updated.parentId, path: updated.path, position: updated.position },
    });
    res.json(updated);
  });

  router.delete("/companies/:companyId/folders/:folderId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const folderId = req.params.folderId as string;
    assertCompanyAccess(req, companyId);
    const deleted = await svc.deleteFolder(companyId, folderId);
    if (!deleted) {
      res.status(404).json({ error: "Folder not found" });
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
      action: "folder.deleted",
      entityType: "folder",
      entityId: deleted.id,
      details: { kind: deleted.kind, name: deleted.name },
    });
    res.json({ deleted });
  });

  return router;
}
