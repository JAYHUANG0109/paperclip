CREATE TABLE IF NOT EXISTS "company_skill_access_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_access_members" ADD CONSTRAINT "company_skill_access_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_access_members" ADD CONSTRAINT "company_skill_access_members_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_access_members_skill_idx" ON "company_skill_access_members" USING btree ("skill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_access_members_principal_idx" ON "company_skill_access_members" USING btree ("company_id","principal_type","principal_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_access_members_unique" ON "company_skill_access_members" USING btree ("skill_id","principal_type","principal_id");
