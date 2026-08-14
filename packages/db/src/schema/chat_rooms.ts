import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * A chat room (space) as a first-class, persisted scope.
 *
 * PHASE 1 — plumbing only. This table makes a Google Chat space (later: LINE
 * group) a stable entity with its own `room_scope_id`, so per-room memory
 * (Phase 2) can key on it. On its own it changes no behaviour: today the room is
 * only a transient string inside the Google Chat plugin's KV state, discarded at
 * issue creation. Populating this table and stamping issues with `room_scope_id`
 * does not alter memory, credentials, or sandboxes yet — nothing reads it until
 * per-room memory is switched on (behind a flag) in Phase 2.
 *
 * Granularity is the ROOM (a Google Chat *space*), not a thread: "each group
 * gets its own memory." DMs are recorded for completeness but stay per-user.
 */
export const chatRooms = pgTable(
  "chat_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** Messaging surface: 'google_chat' today; 'line' reserved for later. */
    surface: text("surface").notNull().default("google_chat"),
    /** The surface's stable space/room id (e.g. Google Chat `spaces/AAAA…`). */
    spaceName: text("space_name").notNull(),
    /** Stable per-room key downstream scoping uses. Derived from the space id. */
    roomScopeId: text("room_scope_id").notNull(),
    /** 'DM' | 'SPACE' | 'ROOM' as reported by the surface. */
    spaceType: text("space_type"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One row per room within a company+surface — the uniqueness per-room memory relies on.
    companyScopeUq: uniqueIndex("chat_rooms_company_scope_uq").on(table.companyId, table.surface, table.roomScopeId),
    companyScopeIdx: index("chat_rooms_company_scope_idx").on(table.companyId, table.roomScopeId),
  }),
);
