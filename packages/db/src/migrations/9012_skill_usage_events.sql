CREATE TABLE IF NOT EXISTS "skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"used_by_user_id" text,
	"used_by_agent_id" uuid,
	"invocations" integer DEFAULT 1 NOT NULL,
	"period_month" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_usage_events" ADD CONSTRAINT "skill_usage_events_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_usage_events_run_skill_unique" ON "skill_usage_events" USING btree ("run_id","skill_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_usage_events_company_period_idx" ON "skill_usage_events" USING btree ("company_id","period_month");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_usage_events_skill_idx" ON "skill_usage_events" USING btree ("skill_id");
