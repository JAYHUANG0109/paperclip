CREATE TABLE "custom_field_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_settings" ADD CONSTRAINT "custom_field_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_settings" ADD CONSTRAINT "custom_field_settings_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_settings" ADD CONSTRAINT "custom_field_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_id_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_settings_project_idx" ON "custom_field_settings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "custom_field_settings_field_idx" ON "custom_field_settings" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_settings_unique" ON "custom_field_settings" USING btree ("field_id","project_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_issue_idx" ON "custom_field_values" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_field_idx" ON "custom_field_values" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_unique" ON "custom_field_values" USING btree ("field_id","issue_id");--> statement-breakpoint
CREATE INDEX "custom_fields_company_idx" ON "custom_fields" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_fields_company_name_idx" ON "custom_fields" USING btree ("company_id","name");