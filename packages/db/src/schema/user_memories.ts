import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Personal memory — facts a user (or their agent) wants remembered across runs.
 *
 * The DB is the source of truth; a materializer writes these out as files for
 * an agent to read, the same way company skills work (`company_skill_files`).
 * That direction matters: an agent editing its own scratch files must never be
 * able to grant itself memory it was not given, and a rebuilt or relocated
 * workspace must not lose anything.
 *
 * ─── Ownership is the security boundary ───
 *
 * `user_id` is the OWNER, and it is the only thing that decides access. Memory
 * is readable by that user, by the agents mapped to them in `agent_memberships`
 * — and by admins, read-only. The rule lives in exactly one place,
 * server/src/services/personal-memory-access.ts; do not restate it in SQL.
 *
 * An agent's access follows the agent's MAPPED user, never whoever triggered
 * the run. A campus head opening a campus member's agent gets the member's
 * memory, not their own.
 *
 * ─── Company-scoped, deliberately ───
 *
 * Scoped by company to match `agent_memberships` (company_id, user_id,
 * agent_id), which is what the access check reads. A user in two companies gets
 * two separate memories rather than one that bleeds across tenants.
 *
 * `user_id` is text with no FK, matching `agent_memberships.user_id` — the
 * auth user table is managed by better-auth and is not referenced from
 * application tables here.
 */
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The OWNER. The only input to the access decision. */
    userId: text("user_id").notNull(),
    /** Stable kebab-case slug, unique per owner — the memory's identity. */
    name: text("name").notNull(),
    /** One-line summary, used to judge relevance during recall. */
    description: text("description").notNull().default(""),
    /**
     * The category: preference | profile | project | feedback | reference.
     *
     * Text rather than an enum so a value written before the set was closed
     * still reads back. `normalizeMemoryCategory` in @paperclipai/shared is the
     * one place that maps legacy and near-miss values forward, and every write
     * goes through it — do not re-derive the set here.
     */
    memoryType: text("memory_type").notNull().default("project"),
    /** UTF-8 markdown body, or base64 when `is_binary` (imported assets). */
    content: text("content").notNull(),
    /**
     * Where it came from: "manual" (typed in the UI), "imported" (a file or
     * folder upload) or "agent" (written by an agent during a run).
     *
     * Same convention as `agent_memberships.source`: anything inserted without
     * naming a source is treated as hand-made, so an importer that later
     * reconciles its own rows can never reclaim one a person wrote.
     */
    source: text("source").notNull().default("manual"),
    /**
     * Groups all memories created in a single import/paste action, so the UI can
     * show import history and select/delete a whole batch. Null for entries not
     * created via an import (typed one-offs, agent writes).
     */
    importBatchId: text("import_batch_id"),
    /**
     * Relative path within the owner's memory directory, preserved on import so
     * a folder round-trips with its structure intact. Null for entries created
     * in the UI, which materialize as `<name>.md`.
     */
    filePath: text("file_path"),
    isBinary: boolean("is_binary").notNull().default(false),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    /** The agent that wrote this, when one did. Provenance only, not authority. */
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /**
     * How many times an agent has arrived at this fact. Repetition is what
     * separates a standing preference from a one-off remark, so it is shown to
     * the owner and available to rank on. Only agent writes bump it — an owner
     * editing their own text is correcting, not confirming.
     */
    timesObserved: integer("times_observed").notNull().default(1),
    /** Last agent confirmation, as distinct from `updated_at`, which also moves on manual edits. */
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    /**
     * Soft delete, with a recovery window (`MEMORY_RECOVERY_WINDOW_DAYS`).
     *
     * Deleting is what people do when memory gets something wrong, and they do
     * it fast — a window makes that safe to do freely, which is what keeps the
     * page honest. Every read filters on `deleted_at is null`; the ONE place
     * that does not is the recovery view. Materialization filters too, so a
     * deleted memory stops reaching agents immediately rather than in 30 days.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The hot path: every read is "this owner's memories in this company". */
    companyUserIdx: index("user_memories_company_user_idx").on(table.companyId, table.userId),
    /**
     * One LIVE memory per slug per owner.
     *
     * Partial on `deleted_at is null` deliberately: a deleted row must not keep
     * reserving its own name, or re-saving a fact that was deleted last month
     * fails on a constraint instead of simply coming back.
     */
    companyUserNameUq: uniqueIndex("user_memories_company_user_name_uq")
      .on(table.companyId, table.userId, table.name)
      .where(sql`${table.deletedAt} is null`),
    companySourceIdx: index("user_memories_source_idx").on(table.companyId, table.source),
  }),
);

/**
 * Per-owner memory switches.
 *
 * Scoped by (company, user) to match `user_memories` and `agent_memberships`;
 * a user in two companies pauses capture in one without touching the other.
 *
 * Absence of a row means enabled. Capture is on by default, and a person who
 * has never opened their Memory page must not need a row to exist before their
 * agents can remember anything — so readers coalesce a missing row to `true`
 * rather than treating it as unset.
 */
export const userMemorySettings = pgTable("user_memory_settings", {
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  /**
   * Whether AGENTS may write. The owner can always write their own memory —
   * pausing is about what gets inferred about you, not about your own notes.
   */
  captureEnabled: boolean("capture_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.companyId, table.userId] }),
}));
