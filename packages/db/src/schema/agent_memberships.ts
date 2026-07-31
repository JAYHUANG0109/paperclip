import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentMemberships = pgTable(
  "agent_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    state: text("state").notNull().default("joined"),
    /**
     * Where this mapping came from: "manual" for rows created in Paperclip, or
     * a reconciler key such as "google_chat_assignment".
     *
     * A reconciler may only add, update or remove rows carrying its own source,
     * so syncing an external assignment list can never delete a mapping made by
     * hand. Defaults to "manual" precisely so that anything inserted without
     * naming a source is treated as hand-made and left alone.
     */
    source: text("source").notNull().default("manual"),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("agent_memberships_company_user_idx").on(table.companyId, table.userId),
    companyUserStarredIdx: index("agent_memberships_company_user_starred_idx").on(
      table.companyId,
      table.userId,
      table.starredAt,
    ),
    agentIdx: index("agent_memberships_agent_idx").on(table.agentId),
    companySourceIdx: index("agent_memberships_source_idx").on(table.companyId, table.source),
    companyUserAgentUq: uniqueIndex("agent_memberships_company_user_agent_uq").on(
      table.companyId,
      table.userId,
      table.agentId,
    ),
  }),
);
