/**
 * Per-room memory (#4 Phase 2, approach B) — foundation.
 *
 * A separate path from personal memory so the fails-closed `(company,user)` model
 * is never touched. This module holds the room-scope resolver, the feature flag,
 * and the room_memories CRUD. Wiring into the run (read/materialize), distillation
 * (write), and the in-run write API come next; until the flag is on and those are
 * wired, nothing here affects behaviour.
 *
 * Authorization principle (enforced by callers, not this store): a run may touch a
 * room's memory only when the run BELONGS to that room — proven by the issue's
 * `originId` matching the room scope. A room owner is a room, never a human, so
 * this never grants an agent access to any person's personal memory.
 */
import { roomMemories, type Db } from "@paperclipai/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/** Surfaces that can own a room. Google Chat today; LINE reserved. */
const KNOWN_SURFACES = ["google_chat", "line"] as const;
export type RoomSurface = (typeof KNOWN_SURFACES)[number];

export interface RoomScope {
  surface: RoomSurface;
  /** The full stable id, e.g. `google_chat:spaces/AAA`. Equals the issue originId. */
  roomScopeId: string;
  /** The surface's raw space id, e.g. `spaces/AAA`. */
  spaceName: string;
}

/**
 * Recognise a group-room run from an issue's `originId`. Phase 1b stamps group
 * (non-DM) chat issues with `${surface}:${spaceName}`; everything else (DMs,
 * non-chat issues, empty) returns null and keeps per-user behaviour.
 */
export function resolveRoomScope(originId: string | null | undefined): RoomScope | null {
  const raw = (originId ?? "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const surface = raw.slice(0, idx) as RoomSurface;
  if (!KNOWN_SURFACES.includes(surface)) return null;
  const spaceName = raw.slice(idx + 1).trim();
  if (!spaceName) return null;
  return { surface, roomScopeId: raw, spaceName };
}

/**
 * Feature flag. Per-room memory is off unless explicitly enabled, so shipping the
 * tables + wiring changes nothing until an operator opts in. Env-based for v1; a
 * per-company/per-room control can layer on later.
 */
export function roomMemoryEnabled(): boolean {
  const v = (process.env.PAPERCLIP_ROOM_MEMORY_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface RoomMemoryRow {
  name: string;
  description: string;
  memoryType: string;
  content: string;
  timesObserved: number;
  updatedAt: Date;
}

/** Live (non-deleted) memories for a room, newest first. */
export async function listRoomMemories(
  db: Db,
  companyId: string,
  roomScopeId: string,
): Promise<RoomMemoryRow[]> {
  const rows = await db
    .select({
      name: roomMemories.name,
      description: roomMemories.description,
      memoryType: roomMemories.memoryType,
      content: roomMemories.content,
      timesObserved: roomMemories.timesObserved,
      updatedAt: roomMemories.updatedAt,
    })
    .from(roomMemories)
    .where(
      and(
        eq(roomMemories.companyId, companyId),
        eq(roomMemories.roomScopeId, roomScopeId),
        isNull(roomMemories.deletedAt),
      ),
    )
    .orderBy(desc(roomMemories.updatedAt));
  return rows;
}

export interface UpsertRoomMemoryInput {
  companyId: string;
  roomScopeId: string;
  surface: RoomSurface;
  name: string;
  content: string;
  description?: string;
  memoryType?: string;
  source?: "agent" | "manual" | "distillation";
  createdByAgentId?: string | null;
}

/**
 * Create or revise one room memory by (company, room, name). Reusing a slug
 * revises in place and bumps `times_observed` — an agent arriving at the same
 * fact again confirms it rather than duplicating it.
 */
export async function upsertRoomMemory(db: Db, input: UpsertRoomMemoryInput): Promise<void> {
  const now = new Date();
  await db
    .insert(roomMemories)
    .values({
      companyId: input.companyId,
      roomScopeId: input.roomScopeId,
      surface: input.surface,
      name: input.name,
      content: input.content,
      description: input.description ?? "",
      memoryType: input.memoryType ?? "project",
      source: input.source ?? "agent",
      createdByAgentId: input.createdByAgentId ?? null,
      lastObservedAt: now,
    })
    .onConflictDoUpdate({
      target: [roomMemories.companyId, roomMemories.roomScopeId, roomMemories.name],
      set: {
        content: input.content,
        description: input.description ?? "",
        memoryType: input.memoryType ?? "project",
        updatedAt: now,
        lastObservedAt: now,
        // An agent arriving at the same fact again confirms it.
        timesObserved: sql`${roomMemories.timesObserved} + 1`,
      },
    });
}

/** Soft-delete one room memory (recoverable), same convention as user memory. */
export async function softDeleteRoomMemory(
  db: Db,
  companyId: string,
  roomScopeId: string,
  name: string,
): Promise<void> {
  await db
    .update(roomMemories)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(roomMemories.companyId, companyId),
        eq(roomMemories.roomScopeId, roomScopeId),
        eq(roomMemories.name, name),
        isNull(roomMemories.deletedAt),
      ),
    );
}
