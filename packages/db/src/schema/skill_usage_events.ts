import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySkills } from "./company_skills.js";

// Per-run skill-invocation telemetry. One row per (run, skill): how many times a
// skill was actually invoked during that run, parsed from the run transcript's
// `Skill` tool calls. This is real usage (not "assigned skills"), and it doubles
// as the idempotency ledger — the unique (run, skill) index guarantees a run's
// usage is counted into company_skill_usage / the leaderboard exactly once even
// if the transcript is re-processed (retry, re-finalize).
export const skillUsageEvents = pgTable(
  "skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => companySkills.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    usedByUserId: text("used_by_user_id"),
    usedByAgentId: uuid("used_by_agent_id"),
    invocations: integer("invocations").notNull().default(1),
    periodMonth: text("period_month").notNull(), // 'YYYY-MM'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSkillUnique: uniqueIndex("skill_usage_events_run_skill_unique").on(table.runId, table.skillId),
    companyPeriodIdx: index("skill_usage_events_company_period_idx").on(table.companyId, table.periodMonth),
    skillIdx: index("skill_usage_events_skill_idx").on(table.skillId),
  }),
);
