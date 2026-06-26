import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";

// Phase 4: Asana-style custom fields.
// custom_fields = the company-level field library (definition).
// custom_field_settings = which projects a field is attached to (many-to-many).
// custom_field_values = a field's value on a specific issue.

export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'people'
    type: text("type").notNull(),
    // For select types: { options: [{ id, label, color }] }. Null for others.
    options: jsonb("options").$type<Record<string, unknown>>(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("custom_fields_company_idx").on(table.companyId),
    companyNameIdx: uniqueIndex("custom_fields_company_name_idx").on(table.companyId, table.name),
  }),
);

export const customFieldSettings = pgTable(
  "custom_field_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("custom_field_settings_project_idx").on(table.projectId),
    fieldIdx: index("custom_field_settings_field_idx").on(table.fieldId),
    uniqueAttach: uniqueIndex("custom_field_settings_unique").on(table.fieldId, table.projectId),
  }),
);

export const customFieldValues = pgTable(
  "custom_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id").notNull().references(() => customFields.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    // Typed value: { text } | { number } | { optionId } | { optionIds } | { date } | { userId/agentId }
    value: jsonb("value").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("custom_field_values_issue_idx").on(table.issueId),
    fieldIdx: index("custom_field_values_field_idx").on(table.fieldId),
    uniqueValue: uniqueIndex("custom_field_values_unique").on(table.fieldId, table.issueId),
  }),
);
