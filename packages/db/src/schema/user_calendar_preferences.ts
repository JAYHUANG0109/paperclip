import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Per-user calendar preferences. Currently holds the editable name-aliases used
 * to match a user's name in freeform Google Calendar event TITLES (the Season
 * Arts team encodes meeting attendees as title text, not real attendees). When a
 * user has no row, defaults are derived from their SSO display name at read time.
 */
export const userCalendarPreferences = pgTable(
  "user_calendar_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    nameAliases: jsonb("name_aliases").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_calendar_preferences_user_uq").on(table.userId),
  }),
);
