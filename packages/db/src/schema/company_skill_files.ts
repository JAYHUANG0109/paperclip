import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";

/**
 * Per-file content for a company skill, so the DB is the single source of truth
 * for a skill's full file set (SKILL.md + references/ + scripts/assets) — not
 * just its SKILL.md (`company_skills.markdown`).
 *
 * Runtime materialization and the skill-file reader prefer a row here when it
 * exists, and otherwise fall back to the legacy on-disk `source_locator` copy —
 * so this is additive and backward-compatible until a skill is migrated.
 *
 * Text files store UTF-8 in `content`; binary assets (images/pdf/office/zip)
 * store base64 in `content` with `binary = true` (rare — most skills are text).
 */
export const companySkillFiles = pgTable(
  "company_skill_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => companySkills.id, { onDelete: "cascade" }),
    // Portable relative path within the skill: "SKILL.md", "references/x.md", …
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    // UTF-8 text, or base64 when `binary` is true.
    content: text("content").notNull(),
    isBinary: boolean("is_binary").notNull().default(false),
    byteSize: integer("byte_size"),
    sha256: text("sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillPathUq: uniqueIndex("company_skill_files_skill_path_uq").on(table.skillId, table.path),
    skillIdx: index("company_skill_files_skill_idx").on(table.skillId),
    companyIdx: index("company_skill_files_company_idx").on(table.companyId),
  }),
);
