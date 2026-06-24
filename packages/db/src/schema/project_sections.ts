import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// Phase 3: Asana-style Sections — user-defined groupings/columns within a project,
// independent of issue status. Issues reference a section via issues.sectionId.
export const projectSections = pgTable(
  "project_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_sections_company_project_idx").on(table.companyId, table.projectId),
    projectPositionIdx: index("project_sections_project_position_idx").on(table.projectId, table.position),
  }),
);
