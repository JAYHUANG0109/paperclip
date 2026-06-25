CREATE TABLE "project_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "project_sections" ADD CONSTRAINT "project_sections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sections" ADD CONSTRAINT "project_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sections_company_project_idx" ON "project_sections" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "project_sections_project_position_idx" ON "project_sections" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_section_id_project_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."project_sections"("id") ON DELETE set null ON UPDATE no action;