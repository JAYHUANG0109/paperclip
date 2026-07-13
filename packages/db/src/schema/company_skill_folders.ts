import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Folder (category) registry. Folders are otherwise just category strings on
 * skills; a row here promotes a folder to a scoped, owned entity so it can be
 * company-wide, team-scoped, or private — and (for the reserved numbered
 * taxonomy) restricted to specific people.
 *
 * A folder WITHOUT a row here behaves exactly as before (a plain company-wide
 * label), so this table is purely additive and backward compatible.
 */
export type CompanySkillFolderScope = "private" | "team" | "company";

export const companySkillFolders = pgTable(
  "company_skill_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Folder display name — matches the category string stored on skills.
    name: text("name").notNull(),
    scope: text("scope").$type<CompanySkillFolderScope>().notNull().default("company"),
    // For scope = "team": the team names allowed to see/use this folder.
    sharingTeams: text("sharing_teams").array().notNull().default([]),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: uniqueIndex("company_skill_folders_company_name_uq").on(table.companyId, table.name),
    companyIdx: index("company_skill_folders_company_idx").on(table.companyId),
  }),
);
