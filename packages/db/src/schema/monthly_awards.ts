import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Frozen monthly leaderboard awards, written by the monthly_rollup job. One row
// per (company, month, awardKey). Idempotent: re-running a month upserts.
export const monthlyAwards = pgTable(
  "monthly_awards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    periodMonth: text("period_month").notNull(), // 'YYYY-MM'
    awardKey: text("award_key").notNull(), // champion | lifetime | crossDept | bounty | viral | rookie
    winnerUserId: text("winner_user_id"),
    winnerName: text("winner_name"),
    value: integer("value").notNull().default(0),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPeriodIdx: index("monthly_awards_company_period_idx").on(table.companyId, table.periodMonth),
    uniqueAward: uniqueIndex("monthly_awards_unique").on(table.companyId, table.periodMonth, table.awardKey),
  }),
);
