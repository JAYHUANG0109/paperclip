/**
 * Room-memory HTTP API (#4 Phase 2 slice 3).
 *
 * A SEPARATE path from personal memory, so the fails-closed `(company,user)`
 * model is never touched. Authorization here is purpose-built for rooms and is
 * the security heart of per-room memory:
 *
 *   an agent may read/write a room's memory ONLY when it is the assignee of an
 *   issue that ORIGINATES from that room — issue.originId == roomScopeId, set
 *   server-side at dispatch (Phase 1b) and unforgeable by the agent.
 *
 * An agent that has never been given a room's issue can never touch that room's
 * memory, and a room scope is never a human, so this can never reach any person's
 * personal memory. `roomScopeId` (e.g. `google_chat:spaces/AAA`) contains a
 * slash, so it travels in the body/query rather than the path.
 */
import { Router, type Request } from "express";
import { issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import {
  listRoomMemories,
  resolveRoomScope,
  softDeleteRoomMemory,
  upsertRoomMemory,
  type RoomSurface,
} from "../services/room-memory.js";

/**
 * Authorize the caller to act on `roomScopeId`, returning the surface. Throws
 * `forbidden` otherwise.
 *
 * The gate: the calling AGENT must be the assignee of at least one issue that
 * ORIGINATES from this room. Phase 1b stamps a group-chat issue's `originId` with
 * exactly the roomScopeId, so this is a direct, cheap check against data the
 * agent cannot forge (assignment is set server-side at dispatch). It proves "this
 * agent serves this room" — an agent that has never been given a room issue can
 * never touch that room's memory, and a room is never a person, so this can never
 * reach anyone's personal memory.
 */
async function assertAgentInRoom(
  db: Db,
  req: Request,
  companyId: string,
  roomScopeId: string,
): Promise<RoomSurface> {
  const scope = resolveRoomScope(roomScopeId);
  if (!scope) throw forbidden("Not a valid room scope");
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw forbidden("Room memory may only be addressed by an agent");
  }
  const owns = (
    await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originId, roomScopeId),
          eq(issues.assigneeAgentId, req.actor.agentId),
        ),
      )
      .limit(1)
  )[0];
  if (!owns) throw forbidden("This agent does not serve that room");
  return scope.surface;
}

function roomScopeFrom(req: Request): string {
  const fromQuery = typeof req.query.roomScopeId === "string" ? req.query.roomScopeId : "";
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = typeof body.roomScopeId === "string" ? body.roomScopeId : "";
  return (fromQuery || fromBody).trim();
}

export function roomMemoryRoutes(db: Db) {
  const router = Router();

  // List a room's live memories. Same run-in-room gate as writing.
  router.get("/companies/:companyId/room-memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roomScopeId = roomScopeFrom(req);
    await assertAgentInRoom(db, req, companyId, roomScopeId);
    res.json({ memories: await listRoomMemories(db, companyId, roomScopeId) });
  });

  // Create or revise one room memory. Provenance is derived from the actor.
  router.put("/companies/:companyId/room-memories/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roomScopeId = roomScopeFrom(req);
    const surface = await assertAgentInRoom(db, req, companyId, roomScopeId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.content !== "string" || !body.content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    await upsertRoomMemory(db, {
      companyId,
      roomScopeId,
      surface,
      name: req.params.name as string,
      content: body.content,
      description: typeof body.description === "string" ? body.description : "",
      memoryType: typeof body.memoryType === "string" ? body.memoryType : undefined,
      source: "agent",
      createdByAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
    });
    res.json({ ok: true });
  });

  // Soft-delete one room memory (recoverable), same gate.
  router.delete("/companies/:companyId/room-memories/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const roomScopeId = roomScopeFrom(req);
    await assertAgentInRoom(db, req, companyId, roomScopeId);
    await softDeleteRoomMemory(db, companyId, roomScopeId, req.params.name as string);
    res.json({ ok: true });
  });

  return router;
}
