import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    /** user | feedback | project | reference. Free text; unknown values sort last. */
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The hot path: every read is "this owner's memories in this company". */
    companyUserIdx: index("user_memories_company_user_idx").on(table.companyId, table.userId),
    /** One memory per slug per owner. */
    companyUserNameUq: uniqueIndex("user_memories_company_user_name_uq").on(
      table.companyId,
      table.userId,
      table.name,
    ),
    companySourceIdx: index("user_memories_source_idx").on(table.companyId, table.source),
  }),
);
