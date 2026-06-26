import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Bounty board (懸賞看板): a posted work/need that someone wants automated. A
// trainer claims it; completing it grants the claimer a 90-day bounty bonus
// (applied in the leaderboard). Lifecycle: open → claimed → done (or cancelled).
export const skillBounties = pgTable(
  "skill_bounties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    estimatedMinutes: integer("estimated_minutes").notNull().default(0),
    status: text("status").notNull().default("open"), // open | claimed | done | cancelled
    postedByUserId: text("posted_by_user_id"),
    postedByName: text("posted_by_name"),
    claimedByUserId: text("claimed_by_user_id"),
    claimedByName: text("claimed_by_name"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    linkedSkillId: uuid("linked_skill_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("skill_bounties_company_status_idx").on(table.companyId, table.status),
    claimedByIdx: index("skill_bounties_claimed_by_idx").on(table.companyId, table.claimedByUserId),
  }),
);
