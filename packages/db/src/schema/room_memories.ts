import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Per-room memory (#4 Phase 2, approach B).
 *
 * A deliberately SEPARATE store from `user_memories`, so per-room memory never
 * touches the fails-closed personal-memory access model. Owner here is a chat
 * room (a group space), identified by `room_scope_id` (e.g. `google_chat:spaces/AAA`).
 * Authorization for reads/writes is "the run belongs to this room" (proven by the
 * issue's originId), enforced on the room-memory path — not the personal-memory
 * `(company,user)` rule, which stays exactly as-is.
 *
 * DMs never use this table; they stay per-user. Nothing writes here unless the
 * room-memory feature flag is on.
 */
export const roomMemories = pgTable(
  "room_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The OWNER: a room's stable scope id, e.g. `google_chat:spaces/AAA`. */
    roomScopeId: text("room_scope_id").notNull(),
    /** Messaging surface the room lives on ('google_chat' today). */
    surface: text("surface").notNull().default("google_chat"),
    /** Stable kebab-case slug, unique per room — the memory's identity. */
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** preference | profile | project | feedback | reference (text, not enum). */
    memoryType: text("memory_type").notNull().default("project"),
    content: text("content").notNull(),
    /** "manual" | "agent" | "distillation". */
    source: text("source").notNull().default("agent"),
    /** The agent that wrote this, when one did. Provenance only, not authority. */
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    timesObserved: integer("times_observed").notNull().default(1),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    /** Soft delete with a recovery window, mirroring user_memories. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The hot path: every read is "this room's memories in this company". */
    companyRoomIdx: index("room_memories_company_room_idx").on(table.companyId, table.roomScopeId),
    /** One LIVE memory per slug per room (partial on not-deleted, like user_memories). */
    companyRoomNameUq: uniqueIndex("room_memories_company_room_name_uq")
      .on(table.companyId, table.roomScopeId, table.name)
      .where(sql`deleted_at is null`),
  }),
);
