/**
 * Chat rooms — Phase 1 plumbing for per-room scope.
 *
 * Promotes a chat space/room to a persisted entity with a stable `roomScopeId`.
 * This is deliberately behaviour-free: it records rooms and hands back a scope id
 * that per-room memory (Phase 2, behind a flag) will key on. Nothing here reads
 * memory, credentials, or sandboxes.
 */
import { chatRooms, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

export type ChatSurface = "google_chat" | "line";

export interface RoomIdentity {
  companyId: string;
  surface: ChatSurface;
  /** The surface's stable space/room id (e.g. Google Chat `spaces/AAAA…`). */
  spaceName: string;
  spaceType?: string | null;
  displayName?: string | null;
}

/**
 * The stable per-room key. Room granularity = one bucket per space (not per
 * thread): "each group gets its own memory." Kept as a small pure function so the
 * derivation is testable and identical everywhere it's computed.
 */
export function deriveRoomScopeId(surface: ChatSurface, spaceName: string): string {
  return `${surface}:${spaceName.trim()}`;
}

/**
 * Record a room (idempotent) and return its row id + scope id. Safe to call on
 * every inbound message: conflicts just refresh `last_seen_at`/`display_name`.
 */
export async function upsertChatRoom(
  db: Db,
  room: RoomIdentity,
): Promise<{ id: string; roomScopeId: string }> {
  const roomScopeId = deriveRoomScopeId(room.surface, room.spaceName);
  const rows = await db
    .insert(chatRooms)
    .values({
      companyId: room.companyId,
      surface: room.surface,
      spaceName: room.spaceName,
      roomScopeId,
      spaceType: room.spaceType ?? null,
      displayName: room.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: [chatRooms.companyId, chatRooms.surface, chatRooms.roomScopeId],
      set: {
        lastSeenAt: sql`now()`,
        displayName: room.displayName ?? sql`${chatRooms.displayName}`,
        spaceType: room.spaceType ?? sql`${chatRooms.spaceType}`,
      },
    })
    .returning({ id: chatRooms.id, roomScopeId: chatRooms.roomScopeId });
  return rows[0]!;
}

/** Look up a room by its stable scope id (Phase 2 will use this on the run path). */
export async function getChatRoomByScope(
  db: Db,
  companyId: string,
  roomScopeId: string,
): Promise<{ id: string; spaceName: string; displayName: string | null } | null> {
  const rows = await db
    .select({ id: chatRooms.id, spaceName: chatRooms.spaceName, displayName: chatRooms.displayName })
    .from(chatRooms)
    .where(and(eq(chatRooms.companyId, companyId), eq(chatRooms.roomScopeId, roomScopeId)))
    .limit(1);
  return rows[0] ?? null;
}
