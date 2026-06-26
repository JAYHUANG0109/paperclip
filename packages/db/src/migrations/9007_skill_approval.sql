ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "approval_status" text DEFAULT 'approved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "approval_note" text;
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_approval_status_idx" ON "company_skills" USING btree ("company_id","approval_status");
