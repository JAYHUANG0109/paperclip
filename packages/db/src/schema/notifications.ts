import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Generic per-user in-app notifications (surfaced in the inbox). Additive and
// self-contained: creating one never touches other tables. `dedupeKey` makes
// creation idempotent (e.g. one "Asana digest refreshed" notice per user/day).
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // e.g. "asana_digest"
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    dedupeKey: text("dedupe_key").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    byUser: index("notifications_company_user_idx").on(table.companyId, table.userId, table.createdAt),
    dedupe: uniqueIndex("notifications_company_dedupe_unique").on(table.companyId, table.dedupeKey),
  }),
);
