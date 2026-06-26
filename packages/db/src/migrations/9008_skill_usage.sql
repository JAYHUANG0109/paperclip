ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "minutes_per_use" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_skill_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"period_month" text NOT NULL,
	"used_by_user_id" text,
	"used_by_agent_id" uuid,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_usage" ADD CONSTRAINT "company_skill_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skill_usage" ADD CONSTRAINT "company_skill_usage_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_usage_skill_period_idx" ON "company_skill_usage" USING btree ("skill_id","period_month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skill_usage_company_period_idx" ON "company_skill_usage" USING btree ("company_id","period_month");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_usage_unique" ON "company_skill_usage" USING btree ("skill_id","period_month","used_by_user_id");
