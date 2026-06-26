import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// Phase 5: per-project access control. Distinct from project_memberships (which is
// sidebar join/left only). A member here has a ROLE on the project and may be a
// user OR an agent. Only consulted when a project's visibility is 'private' and the
// PAPERCLIP_PROJECT_PRIVACY feature flag is on.
export const projectAccessMembers = pgTable(
  "project_access_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(), // 'user' | 'agent'
    principalId: text("principal_id").notNull(),
    projectRole: text("project_role").notNull().default("editor"), // 'admin' | 'editor' | 'commenter' | 'viewer'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("project_access_members_project_idx").on(table.projectId),
    principalIdx: index("project_access_members_principal_idx").on(table.companyId, table.principalType, table.principalId),
    uniqueMember: uniqueIndex("project_access_members_unique").on(table.projectId, table.principalType, table.principalId),
  }),
);
