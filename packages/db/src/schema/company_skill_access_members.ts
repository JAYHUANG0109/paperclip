import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";

// Skill-level access control. Only consulted when a skill's sharingScope is
// 'private': the skill is then visible to its creator (companySkills.createdByUserId),
// these explicit members, and company owners/admins. Mirrors project_access_members.
export const companySkillAccessMembers = pgTable(
  "company_skill_access_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(), // 'user' (agents read via assignment, not here)
    principalId: text("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillIdx: index("company_skill_access_members_skill_idx").on(table.skillId),
    principalIdx: index("company_skill_access_members_principal_idx").on(table.companyId, table.principalType, table.principalId),
    uniqueMember: uniqueIndex("company_skill_access_members_unique").on(table.skillId, table.principalType, table.principalId),
  }),
);
