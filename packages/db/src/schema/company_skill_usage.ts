import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";

// Per-month usage ledger for the leaderboard. One row per (skill, month, user),
// upserted with an incrementing count. "minutes saved" is derived as the skill's
// minutesPerUse × count. Distinct users on a skill drive the team bonus.
export const companySkillUsage = pgTable(
  "company_skill_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    periodMonth: text("period_month").notNull(), // 'YYYY-MM'
    usedByUserId: text("used_by_user_id"),
    usedByAgentId: uuid("used_by_agent_id"),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillPeriodIdx: index("company_skill_usage_skill_period_idx").on(table.skillId, table.periodMonth),
    companyPeriodIdx: index("company_skill_usage_company_period_idx").on(table.companyId, table.periodMonth),
    uniqueRow: uniqueIndex("company_skill_usage_unique").on(table.skillId, table.periodMonth, table.usedByUserId),
  }),
);
