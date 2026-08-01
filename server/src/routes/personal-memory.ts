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
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, isPrivilegedMemberViewer } from "./authz.js";
import {
  deletePersonalMemory,
  listPersonalMemories,
  materializeUserMemory,
  requesterForAgent,
  upsertPersonalMemory,
} from "../services/personal-memory.js";
import type { MemoryRequester } from "../services/personal-memory-access.js";

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

  router.get("/companies/:companyId/users/:userId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = req.params.userId as string;
    assertCompanyAccess(req, companyId);
    const requester = await resolveRequester(req, companyId);
    const memories = await listPersonalMemories(db, { companyId, requester, ownerUserId });
    res.json(
      memories.map((memory) => ({
        name: memory.name,
        description: memory.description,
        memoryType: memory.memoryType,
        content: memory.isBinary ? null : memory.content,
        source: memory.source,
        filePath: memory.filePath,
        isBinary: memory.isBinary,
        updatedAt: memory.updatedAt,
      })),
    );
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

    const saved = await upsertPersonalMemory(db, {
      companyId,
      ownerUserId,
      requester,
      name: req.params.name as string,
      description: typeof body.description === "string" ? body.description : "",
      memoryType: typeof body.memoryType === "string" ? body.memoryType : "project",
      content: body.content,
      // Provenance is derived from the actor, never accepted from the body — a
      // caller must not be able to label its own write as something else.
      source: requester.kind === "agent" ? "agent" : "manual",
      createdByAgentId: requester.kind === "agent" ? requester.agentId : null,
    });

    // A refused write is indistinguishable from a missing owner on purpose:
    // "you may not write this person's memory" and "this person has none"
    // should not be tellable apart by someone probing for who exists.
    if (!saved) throw notFound("Memory not found");

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    res.json({ name: saved.name, updatedAt: saved.updatedAt });
  });

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
    });
    if (!deleted) throw notFound("Memory not found");

    await materializeUserMemory(db, { companyId, userId: ownerUserId });
    res.status(204).end();
  });

  return router;
}
