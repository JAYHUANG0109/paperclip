CREATE TABLE IF NOT EXISTS "company_skill_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'company' NOT NULL,
	"sharing_teams" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_skill_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_folders_company_name_uq" ON "company_skill_folders" USING btree ("company_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_folders_company_idx" ON "company_skill_folders" USING btree ("company_id");
