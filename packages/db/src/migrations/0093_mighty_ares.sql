CREATE TABLE "project_access_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"project_role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access_members" ADD CONSTRAINT "project_access_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_access_members" ADD CONSTRAINT "project_access_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_access_members_project_idx" ON "project_access_members" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_access_members_principal_idx" ON "project_access_members" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_access_members_unique" ON "project_access_members" USING btree ("project_id","principal_type","principal_id");