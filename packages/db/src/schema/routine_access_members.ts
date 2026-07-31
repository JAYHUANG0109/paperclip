import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { routines } from "./routines.js";

/**
 * Explicit per-principal access grants for routines — the "share this with a specific
 * person" half of routine visibility. Mirrors company_skill_access_members.
 *
 * Users only: an agent reaches a routine by being its assignee, never through a
 * share, so there is no agent principal type here.
 */
export const routineAccessMembers = pgTable(
  "routine_access_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull().references(() => routines.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routineIdx: index("routine_access_members_routine_idx").on(table.routineId),
    principalIdx: index("routine_access_members_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    uniqueMember: uniqueIndex("routine_access_members_unique").on(
      table.routineId,
      table.principalType,
      table.principalId,
    ),
  }),
);
