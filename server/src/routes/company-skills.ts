import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { authUsers, companySkills } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { leaderboardService } from "../services/leaderboard.js";
import { progressionFor } from "../services/office-progression.js";
import { notificationService } from "../services/notifications.js";
import {
  catalogSkillListQuerySchema,
  companySkillCommentCreateSchema,
  companySkillCommentUpdateSchema,
  companySkillCreateSchema,
  companySkillFileUpdateSchema,
  companySkillForkSchema,
  companySkillImportSchema,
  companySkillInstallCatalogSchema,
  companySkillInstallUpdateSchema,
  companySkillListQuerySchema,
  companySkillProjectScanRequestSchema,
  companySkillResetSchema,
  companySkillUpdateSchema,
  companySkillVersionCreateSchema,
} from "@paperclipai/shared";
import { trackSkillImported } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, companySkillService, logActivity } from "../services/index.js";
import {
  getCatalogSkillOrThrow,
  listCatalogSkillsOrEmpty,
  readCatalogSkillFile,
} from "../services/skills-catalog.js";
import { forbidden } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo, isPrivilegedMemberViewer } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";

type SkillTelemetryInput = {
  key: string;
  slug: string;
  sourceType: string;
  sourceLocator: string | null;
  metadata: Record<string, unknown> | null;
};

export function companySkillRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companySkillService(db);

  function canCreateSkills(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return true;
    return (agent.permissions as Record<string, unknown>).canCreateSkills !== false;
  }

  function asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function deriveTrackedSkillRef(skill: SkillTelemetryInput): string | null {
    if (skill.sourceType === "skills_sh") {
      return skill.key;
    }
    if (skill.sourceType !== "github") {
      return null;
    }
    const hostname = asString(skill.metadata?.hostname);
    if (hostname !== "github.com") {
      return null;
    }
    return skill.key;
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  function queryStringArray(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
    return [];
  }

  function skillActor(req: Request) {
    if (req.actor.type === "agent") {
      return { type: "agent" as const, agentId: req.actor.agentId ?? null };
    }
    if (req.actor.type === "board") {
      return { type: "user" as const, userId: req.actor.userId ?? null };
    }
    return { type: "system" as const };
  }

  async function assertCanMutateCompanySkills(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "skills:create");
      if (!allowed) {
        throw forbidden("Missing permission: skills:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    if (canCreateSkills(actorAgent)) {
      return;
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "skills:create");
    if (allowedByGrant) {
      return;
    }

    throw forbidden("Missing permission: skills:create");
  }

  router.get("/skills/catalog", async (req, res) => {
    assertAuthenticated(req);
    const query = catalogSkillListQuerySchema.parse({
      kind: firstQueryString(req.query.kind),
      category: firstQueryString(req.query.category),
      q: firstQueryString(req.query.q),
    });
    res.json(listCatalogSkillsOrEmpty(query));
  });

  router.get("/skills/catalog/:catalogId/files", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    const relativePath = firstQueryString(req.query.path) ?? "SKILL.md";
    res.json(await readCatalogSkillFile(catalogRef, relativePath));
  });

  router.get("/skills/catalog/:catalogId", async (req, res) => {
    assertAuthenticated(req);
    const catalogRef = firstQueryString(req.query.ref) ?? (req.params.catalogId as string);
    res.json(getCatalogSkillOrThrow(catalogRef));
  });

  router.get("/companies/:companyId/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const viewer = req.actor.type === "board"
      ? { userId: req.actor.userId ?? null, isPrivileged: isPrivilegedMemberViewer(req, companyId, true) }
      : { isPrivileged: true }; // agents resolve skills via assignment; no privacy filter
    const result = await svc.list(companyId, companySkillListQuerySchema.parse({
      q: firstQueryString(req.query.q),
      sort: firstQueryString(req.query.sort),
      categories: [
        ...queryStringArray(req.query.category),
        ...queryStringArray(req.query.categories),
        ...queryStringArray(req.query["categories[]"]),
      ],
      scope: firstQueryString(req.query.scope),
    }), viewer);
    res.json(result);
  });

  router.get("/companies/:companyId/skills/categories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.categoryCounts(companyId));
  });

  router.get("/companies/:companyId/skills/pending-approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const pending = await svc.listPendingApprovals(companyId);
    if (isPrivilegedMemberViewer(req, companyId, true)) {
      res.json(pending);
      return;
    }
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    res.json(pending.filter((s) => s.createdByUserId === userId));
  });

  router.get("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.detail(companyId, skillId, skillActor(req));
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  // ---- Skill approval (review queue) ----
  router.post("/companies/:companyId/skills/:skillId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can review skills" });
      return;
    }
    const reviewerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const row = await svc.setApprovalStatus(companyId, skillId, "approved", reviewerUserId, null);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json(row);
  });

  router.post("/companies/:companyId/skills/:skillId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can review skills" });
      return;
    }
    const reviewerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    const note = typeof (req.body as Record<string, unknown>)?.note === "string"
      ? ((req.body as Record<string, unknown>).note as string)
      : null;
    const row = await svc.setApprovalStatus(companyId, skillId, "rejected", reviewerUserId, note);
    if (!row) { res.status(404).json({ error: "Skill not found" }); return; }
    res.json(row);
  });

  // ---- Skill sharing: private-access members ----
  router.get("/companies/:companyId/skills/:skillId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listSkillAccessMembers(companyId, skillId));
  });

  router.post("/companies/:companyId/skills/:skillId/members", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const principalId = String((req.body as Record<string, unknown>)?.principalId ?? "").trim();
    if (!principalId) {
      res.status(400).json({ error: "principalId is required" });
      return;
    }
    res.status(201).json(await svc.addSkillAccessMember(companyId, skillId, principalId));
  });

  router.delete("/companies/:companyId/skills/:skillId/members/:principalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const principalId = req.params.principalId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const removed = await svc.removeSkillAccessMember(companyId, skillId, principalId);
    if (!removed) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.json(removed);
  });

  router.get("/companies/:companyId/skills/:skillId/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listVersions(companyId, skillId));
  });

  router.get("/companies/:companyId/skills/:skillId/versions/:versionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const versionId = req.params.versionId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getVersion(companyId, skillId, versionId);
    if (!result) {
      res.status(404).json({ error: "Skill version not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/versions",
    validate(companySkillVersionCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.createVersion(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_version_created",
        entityType: "company_skill_version",
        entityId: result.id,
        details: {
          skillId,
          revisionNumber: result.revisionNumber,
          label: result.label,
        },
      });
      res.status(201).json(result);
    },
  );

  router.post("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.starSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_starred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.delete("/companies/:companyId/skills/:skillId/star", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.unstarSkill(companyId, skillId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_unstarred",
      entityType: "company_skill",
      entityId: skillId,
      details: { starCount: result.starCount },
    });
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/fork",
    validate(companySkillForkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.forkSkill(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_forked",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          sourceSkillId: skillId,
          slug: result.slug,
          name: result.name,
        },
      });
      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/skills/:skillId/comments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listComments(companyId, skillId));
  });

  router.post(
    "/companies/:companyId/skills/:skillId/comments",
    validate(companySkillCommentCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.createComment(companyId, skillId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_comment_created",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId, parentCommentId: result.parentCommentId },
      });
      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/comments/:commentId",
    validate(companySkillCommentUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      const commentId = req.params.commentId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.updateComment(companyId, skillId, commentId, req.body, skillActor(req));
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_comment_updated",
        entityType: "company_skill_comment",
        entityId: result.id,
        details: { skillId },
      });
      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId/comments/:commentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const commentId = req.params.commentId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.deleteComment(companyId, skillId, commentId, skillActor(req));
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_comment_deleted",
      entityType: "company_skill_comment",
      entityId: result.id,
      details: { skillId },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/update-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.updateStatus(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    assertCompanyAccess(req, companyId);
    const result = await svc.readFile(companyId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills",
    validate(companySkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.createLocalSkill(companyId, req.body, skillActor(req), { isPrivileged: isPrivilegedMemberViewer(req, companyId, true) });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId",
    validate(companySkillUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.updateSkill(companyId, skillId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_updated",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          categories: result.categories,
          sharingScope: result.sharingScope,
        },
      });

      res.json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
        skillActor(req),
      );

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import",
    validate(companySkillImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const source = String(req.body.source ?? "");
      const result = await svc.importFromSource(companyId, source);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
        },
      });
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        for (const skill of result.imported) {
          trackSkillImported(telemetryClient, {
            sourceType: skill.sourceType,
            skillRef: deriveTrackedSkillRef(skill),
          });
        }
      }

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/install-catalog",
    validate(companySkillInstallCatalogSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.installFromCatalog(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: result.action === "created" ? "company.skill_catalog_installed" : "company.skill_catalog_updated",
        entityType: "company_skill",
        entityId: result.skill.id,
        details: {
          action: result.action,
          catalogId: result.catalogSkill.id,
          catalogKey: result.catalogSkill.key,
          slug: result.skill.slug,
          originHash: result.catalogSkill.contentHash,
          warningCount: result.warnings.length,
        },
      });

      res.status(result.action === "created" ? 201 : 200).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/scan-projects",
    validate(companySkillProjectScanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.scanProjectWorkspaces(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_scanned",
        entityType: "company",
        entityId: companyId,
        details: {
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const result = await svc.deleteSkill(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_deleted",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills/:skillId/audit",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.auditSkill(companyId, skillId);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_audited",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          verdict: result.verdict,
          codes: result.codes,
          installedHash: result.installedHash,
          originHash: result.originHash,
          scanVersion: result.scanVersion,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/install-update",
    validate(companySkillInstallUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const before = await svc.getById(companyId, skillId);
      const result = await svc.installUpdate(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_update_installed",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/:skillId/reset",
    validate(companySkillResetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const before = await svc.getById(companyId, skillId);
      const result = await svc.resetSkill(companyId, skillId, req.body);
      if (!result) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_reset",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          previousOriginHash: before?.metadata?.originHash ?? before?.sourceRef ?? null,
          previousOriginVersion: before?.metadata?.originVersion ?? null,
          newOriginHash: result.metadata?.originHash ?? result.sourceRef,
          newOriginVersion: result.metadata?.originVersion ?? null,
          driftDetected: Boolean(before?.metadata?.userModifiedAt),
          force: Boolean(req.body.force),
          auditVerdict: result.metadata?.auditVerdict ?? null,
        },
      });

      res.json(result);
    },
  );

  // The teams the current user can share a skill with (their joined agents''' teams).
  router.get("/companies/:companyId/my-teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    if (!userId) { res.json({ teams: [] }); return; }
    const teams = await svc.getUserTeams(companyId, userId);
    res.json({ teams: [...teams].sort() });
  });

  // ---- Virtual office: per-agent skill counts ----
  router.get("/companies/:companyId/agent-skill-counts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.agentSkillCounts(companyId));
  });

  // ---- Leaderboard (排行榜) ----
  const leaderboard = leaderboardService(db);
  const notifications = notificationService(db);

  router.get("/companies/:companyId/leaderboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const periodParam = typeof req.query.period === "string" ? req.query.period : null;
    const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : null; // null = lifetime
    const result = await leaderboard.compute(companyId, period);
    // Resolve display names for the ranked users.
    const userIds = result.entries.map((e) => e.userId).filter(Boolean);
    const users = userIds.length
      ? await db.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
          .from(authUsers).where(inArray(authUsers.id, userIds))
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id.slice(0, 8)]));
    // Frozen awards for the requested month (lifetime view → current month).
    const awardsMonth = period ?? new Date().toISOString().slice(0, 7);
    const awards = await leaderboard.listAwards(companyId, awardsMonth);
    res.json({
      period: result.period,
      // Attach the Virtual Office progression (XP/level/title/coins/badges),
      // computed purely from each entry. coinsSpent is 0 until the shop ships.
      entries: result.entries.map((e) => ({
        ...e,
        displayName: nameById.get(e.userId) ?? e.userId.slice(0, 8),
        progression: progressionFor(e),
      })),
      awards,
    });
  });

  // Manually run the monthly rollup (admin) — freezes that month's award winners.
  router.post("/companies/:companyId/leaderboard/rollup", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanMutateCompanySkills(req, companyId);
    if (!isPrivilegedMemberViewer(req, companyId, true)) {
      res.status(403).json({ error: "Only owners/admins can run the rollup" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const period = typeof body.period === "string" && /^\d{4}-\d{2}$/.test(body.period)
      ? body.period
      : new Date().toISOString().slice(0, 7);
    const winners = await leaderboard.runMonthlyRollup(companyId, period);
    res.json({ period, winners });
  });

  // Record one use of a skill (agents/automations call this when they use a skill).
  router.post("/companies/:companyId/skills/:skillId/record-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const periodMonth = typeof body.periodMonth === "string" && /^\d{4}-\d{2}$/.test(body.periodMonth)
      ? body.periodMonth
      : new Date().toISOString().slice(0, 7);
    const usedByUserId = req.actor.type === "board" ? req.actor.userId ?? null : (typeof body.usedByUserId === "string" ? body.usedByUserId : null);
    const usedByAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : (typeof body.usedByAgentId === "string" ? body.usedByAgentId : null);
    const increment = typeof body.increment === "number" && body.increment > 0 ? Math.min(1000, Math.round(body.increment)) : 1;
    const row = await leaderboard.recordUsage(companyId, skillId, periodMonth, usedByUserId, usedByAgentId, increment);

    // Reward loop: when a real user adopts someone else's skill, notify the
    // author — once per adopter (deduped), so repeat uses never spam. Best-effort:
    // a notification failure must never break usage recording.
    if (usedByUserId) {
      try {
        const [skill] = await db
          .select({ name: companySkills.name, author: companySkills.createdByUserId })
          .from(companySkills)
          .where(eq(companySkills.id, skillId))
          .limit(1);
        if (skill?.author && skill.author !== usedByUserId) {
          const [user] = await db
            .select({ name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, usedByUserId))
            .limit(1);
          const who = user?.name ?? user?.email ?? "有人 / Someone";
          await notifications.create({
            companyId,
            userId: skill.author,
            kind: "office_skill_adopted",
            title: `🎉 ${who} 用了你的技能 / used your skill`,
            body: `《${skill.name}》被採用了——你的自動化正在幫團隊省時間。 / Your automation is saving the team time.`,
            link: "/virtual-office",
            dedupeKey: `office-skill-adopted:${skillId}:${usedByUserId}`,
          });
        }
      } catch {
        /* notifications are best-effort */
      }
    }

    res.json(row);
  });

  return router;
}
