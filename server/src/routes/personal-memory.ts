/**
 * Personal memory HTTP surface.
 *
 * Every handler resolves the requester through one helper, `resolveRequester`,
 * which is the ONLY place the actor is turned into a memory identity. For an
 * agent-authenticated caller it consults `agent_memberships` and ignores the
 * request's user entirely; for a board caller it is that user. Routes never
 * touch `req.actor.userId` for an agent, because they never see the choice.
 *
 * Owner is always explicit in the path (`/users/:userId/memories`), so reading
 * someone else's memory is a decision the access rule makes, not an accident of
 * which id happened to be in scope.
 */
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { parseMemoryDump } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, isPrivilegedMemberViewer } from "./authz.js";
import {
  deleteImportBatches,
  deletePersonalMemory,
  getMemorySettings,
  listDeletedPersonalMemories,
  listImportBatches,
  listPersonalMemories,
  materializeUserMemory,
  personalMemoryStats,
  requesterForAgent,
  restorePersonalMemory,
  setMemorySettings,
  upsertPersonalMemory,
  type MemoryRecord,
  type MemoryWriteRefusal,
} from "../services/personal-memory.js";
import { canReadPersonalMemory, type MemoryRequester } from "../services/personal-memory-access.js";
import {
  buildMemorySeedDigest,
  countExistingMemories,
  renderMemorySeedTask,
  seedIsWorthwhile,
} from "../services/memory-seed.js";
import { MAX_MEMORY_FILE_BYTES, parseMemoryUploads } from "../services/personal-memory-import.js";

/** Ceiling on files per import. Bounds one request, not the store. */
const MAX_MEMORY_IMPORT_FILES = 200;

export function personalMemoryRoutes(db: Db) {
  const router = Router();

  /**
   * Turn the authenticated actor into a memory requester.
   *
   * The agent branch deliberately never reads `req.actor.userId`: an agent's
   * memory follows its own mapping, so a campus head driving a member's agent
   * reaches the member's memory and nothing else.
   */
  async function resolveRequester(req: Request, companyId: string): Promise<MemoryRequester> {
    if (req.actor.type === "agent") {
      const agentId = req.actor.agentId;
      if (!agentId) throw forbidden("Agent actor without an agent id cannot read personal memory");
      return requesterForAgent(db, { companyId, agentId });
    }
    const userId = req.actor.type === "board" ? req.actor.userId : undefined;
    if (!userId) throw forbidden("Personal memory requires an authenticated user");
    return { kind: "user", userId, isAdmin: isPrivilegedMemberViewer(req, companyId, true) };
  }

  /**
   * Turn a refusal into a response.
   *
   * `forbidden` is the only one that hides itself: "you may not write this
   * person's memory" and "this person has none" must not be tellable apart by
   * someone probing for who exists. The rest are the writer's own mistake and
   * are stated plainly, because a caller that cannot see why it was refused
   * will simply retry the same write.
   */
  function refuse(res: Response, refusal: MemoryWriteRefusal): void {
    if (refusal.reason === "forbidden") throw notFound("Memory not found");
    const status = refusal.reason === "rate_limited" ? 429 : 422;
    res.status(status).json({ error: refusal.message, reason: refusal.reason, screenClass: refusal.screenClass });
  }

  /**
   * One shape for a memory, used by every reader.
   *
   * Content is withheld for binary entries — an imported PNG's base64 is not
   * something any caller of this API wants inlined in a list response.
   */
  function present(memory: MemoryRecord) {
    return {
      name: memory.name,
      description: memory.description,
      memoryType: memory.memoryType,
      content: memory.isBinary ? null : memory.content,
      source: memory.source,
      filePath: memory.filePath,
      isBinary: memory.isBinary,
      // Repetition is why an agent-written fact is trusted, so the owner sees
      // it rather than it staying an internal ranking signal.
      timesObserved: memory.timesObserved,
      lastObservedAt: memory.lastObservedAt,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      deletedAt: memory.deletedAt,
    };
  }

  router.get("/companies/:companyId/users/:userId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    const memories = await listPersonalMemories(db, { companyId, requester, ownerUserId });
    res.json(memories.map(present));
  });

  // Import history: the batches created by paste/file imports, so the owner can
  // review and select/delete whole batches at once.
  router.get("/companies/:companyId/users/:userId/memories/import-batches", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    res.json(await listImportBatches(db, { companyId, requester, ownerUserId }));
  });

  router.post("/companies/:companyId/users/:userId/memories/import-batches/delete", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    const raw = (req.body ?? {}) as { batchIds?: unknown };
    const batchIds = Array.isArray(raw.batchIds) ? raw.batchIds.filter((x): x is string => typeof x === "string") : [];
    const deleted = await deleteImportBatches(db, { companyId, requester, ownerUserId, batchIds });
    res.json({ deleted });
  });

  /**
   * Recently deleted memories, and the switches.
   *
   * Both are the owner's control surface rather than their content, which is
   * why they sit beside the list rather than in it. Deleted entries are read
   * under the same rule as live ones — an admin who may read a person's memory
   * may see what they removed, and nobody else can.
   */
  router.get("/companies/:companyId/users/:userId/memories/deleted", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    if (!canReadPersonalMemory({ ownerUserId }, requester)) throw notFound("Memory not found");
    const memories = await listDeletedPersonalMemories(db, { companyId, requester, ownerUserId });
    res.json(memories.map(present));
  });

  router.get("/companies/:companyId/users/:userId/memories/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    if (!canReadPersonalMemory({ ownerUserId }, requester)) throw notFound("Memory not found");
    res.json(await getMemorySettings(db, { companyId, userId: ownerUserId }));
  });

  /**
   * Pause or resume capture.
   *
   * Write-gated, not read-gated: an admin may read someone's memory, but
   * deciding whether that person's agents get to learn about them is theirs.
   * `setMemorySettings` also refuses agents outright — an agent that could turn
   * its own leash off is not on a leash.
   */
  router.put("/companies/:companyId/users/:userId/memories/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.captureEnabled !== "boolean") {
      res.status(400).json({ error: "captureEnabled must be a boolean" });
      return;
    }

    const settings = await setMemorySettings(db, {
      companyId,
      ownerUserId,
      requester,
      captureEnabled: body.captureEnabled,
    });
    if (!settings) throw notFound("Memory not found");
    res.json(settings);
  });

  /**
   * Take a deleted memory back.
   *
   * A POST on the deleted entry rather than a PUT of its content: the owner is
   * asking for what was there, not supplying it again, and re-uploading would
   * lose the observation count that made the entry trustworthy.
   */
  router.post("/companies/:companyId/users/:userId/memories/:name/restore", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    const restored = await restorePersonalMemory(db, {
      companyId,
      ownerUserId,
      requester,
      name: req.params.name as string,
    });
    if (!restored.ok) {
      // "Not yours" and "no such memory" stay indistinguishable; a name clash is
      // the caller's own situation and is worth explaining.
      if (restored.reason === "name_taken") {
        res.status(409).json({ error: restored.message, reason: restored.reason });
        return;
      }
      throw notFound("Memory not found");
    }

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    res.json(present(restored.memory));
  });

  router.put("/companies/:companyId/users/:userId/memories/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const result = await upsertPersonalMemory(db, {
      companyId,
      ownerUserId,
      requester,
      name: req.params.name as string,
      description: typeof body.description === "string" ? body.description : "",
      memoryType: typeof body.memoryType === "string" ? body.memoryType : undefined,
      content: body.content,
      // Provenance is derived from the actor, never accepted from the body — a
      // caller must not be able to label its own write as something else. The
      // screen is asymmetric between agents and owners, so this is load-bearing.
      source: requester.kind === "agent" ? "agent" : "manual",
      createdByAgentId: requester.kind === "agent" ? requester.agentId : null,
      // Optional fact date (from an imported "[date] - …") to seed recency.
      observedAt: typeof body.observedAt === "string" && !Number.isNaN(Date.parse(body.observedAt))
        ? new Date(body.observedAt)
        : null,
      importBatchId: typeof body.importBatchId === "string" && body.importBatchId.trim() ? body.importBatchId.trim() : null,
    });

    if (!result.ok) {
      refuse(res, result);
      return;
    }

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    // `deduped` tells a writer its fact was already held under another name, so
    // it stops trying to add it. Silently succeeding would teach it nothing.
    res.json({
      name: result.memory.name,
      memoryType: result.memory.memoryType,
      timesObserved: result.memory.timesObserved,
      deduped: result.deduped,
      updatedAt: result.memory.updatedAt,
    });
  });

  /**
   * Is memory actually being written?
   *
   * Exists so that question has an answer other than "watch the page for a few
   * days". Capture is asked for in the agent prompt, and a prompt can quietly
   * fail to land; these counts show whether it did.
   */
  router.get("/companies/:companyId/users/:userId/memories/stats", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    const stats = await personalMemoryStats(db, { companyId, ownerUserId, requester });
    if (!stats) throw notFound("Memory not found");
    res.json(stats);
  });

  /**
   * The brief for catching memory up on work already done.
   *
   * Returns the digest and the task text; it does NOT create the task and does
   * not write a single memory. Creating the task is the caller's move, and the
   * distillation happens on a normal agent run through the normal write gate —
   * so a backfill cannot slip past the category rules, the screen or the limits
   * that every other memory has to satisfy.
   */
  router.get("/companies/:companyId/users/:userId/memories/seed", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    // Reading someone's whole work history is at least as revealing as reading
    // their memory, so it is gated on the same rule rather than a weaker one.
    if (!canReadPersonalMemory({ ownerUserId }, requester)) throw notFound("Memory not found");

    const digest = await buildMemorySeedDigest(db, { companyId, userId: ownerUserId });
    const task = renderMemorySeedTask(digest);
    const existingMemories = await countExistingMemories(db, { companyId, userId: ownerUserId });

    res.json({
      worthwhile: seedIsWorthwhile(digest),
      existingMemories,
      totalIssues: digest.totalIssues,
      completedIssues: digest.completedIssues,
      agentNames: digest.agentNames,
      projects: digest.projectCounts,
      task,
    });
  });

  /**
   * Import files or a whole folder into a user's memory.
   *
   * Uploads are parsed by `personal-memory-import.ts`, which refuses unsafe
   * paths at the door rather than storing them and trusting a later
   * materializer to be careful. Everything it refused comes back in `skipped`,
   * so a partial import never reads as a complete one.
   */
  router.post("/companies/:companyId/users/:userId/memories/import", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_MEMORY_FILE_BYTES, files: MAX_MEMORY_IMPORT_FILES },
    });
    await new Promise<void>((resolve, reject) => {
      upload.array("files", MAX_MEMORY_IMPORT_FILES)(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files were uploaded" });
      return;
    }

    const { memories, skipped } = parseMemoryUploads(
      files.map((file) => ({ relativePath: file.originalname, content: file.buffer })),
    );

    // One batch id for the whole upload, so file imports show up in history and
    // can be selected/deleted as a unit — same as a paste.
    const batchId = randomUUID();
    // Expand a text file that is itself a dated dump into per-entry rows (dates +
    // per-entry categories), so file uploads behave like the paste box. Discrete
    // files (skills, single notes) stay as one entry.
    type ImportRow = { name: string; description: string; memoryType: string; content: string; filePath: string; isBinary: boolean; observedAt: Date | null };
    const usedNames = new Set<string>();
    const slugFromContent = (s: string) =>
      s.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "memory";
    const uniqueName = (base: string) => {
      let name = base || "memory";
      for (let i = 2; usedNames.has(name); i += 1) name = `${base}-${i}`;
      usedNames.add(name);
      return name;
    };
    const rows: ImportRow[] = [];
    for (const memory of memories) {
      if (!memory.isBinary) {
        const parsed = parseMemoryDump(memory.content);
        if (parsed.length > 1) {
          for (const entry of parsed) {
            rows.push({
              name: uniqueName(slugFromContent(entry.content)),
              description: "",
              memoryType: entry.category,
              content: entry.content,
              filePath: memory.filePath,
              isBinary: false,
              observedAt: entry.observedAt ? new Date(entry.observedAt) : null,
            });
          }
          continue;
        }
      }
      rows.push({
        name: uniqueName(memory.name),
        description: memory.description,
        memoryType: memory.memoryType,
        content: memory.content,
        filePath: memory.filePath,
        isBinary: memory.isBinary,
        observedAt: null,
      });
    }

    const imported: string[] = [];
    const refused: Array<{ relativePath: string; reason: string }> = [...skipped];
    for (const memory of rows) {
      const saved = await upsertPersonalMemory(db, {
        companyId,
        ownerUserId,
        requester,
        name: memory.name,
        description: memory.description,
        memoryType: memory.memoryType,
        content: memory.content,
        source: "imported",
        filePath: memory.filePath,
        isBinary: memory.isBinary,
        observedAt: memory.observedAt,
        importBatchId: batchId,
        createdByAgentId: requester.kind === "agent" ? requester.agentId : null,
      });
      // `forbidden` is the access rule, not the file: the requester may not
      // write this owner's memory at all, so stop rather than reporting every
      // file individually. Anything else is about THIS file — a document
      // carrying a key, say — and belongs in `skipped` beside the paths the
      // parser refused, so a partial import still reads as partial.
      if (!saved.ok) {
        if (saved.reason === "forbidden") throw notFound("Memory not found");
        refused.push({ relativePath: memory.filePath, reason: saved.message });
        continue;
      }
      imported.push(saved.memory.name);
    }

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    res.json({ imported, skipped: refused });
  });

  /**
   * Delete a memory — recoverable for 30 days unless `?purge=true`.
   *
   * Purge is opt-in rather than the default because deleting is what people do
   * when memory gets something wrong, and they do it in a hurry. The recovery
   * view is where "delete forever" belongs: by then the decision is deliberate.
   */
  router.delete("/companies/:companyId/users/:userId/memories/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);

    const deleted = await deletePersonalMemory(db, {
      companyId,
      ownerUserId,
      requester,
      name: req.params.name as string,
      purge: req.query.purge === "true",
    });
    if (!deleted) throw notFound("Memory not found");

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    res.status(204).end();
  });

  return router;
}
