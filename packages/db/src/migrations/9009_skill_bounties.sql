CREATE TABLE IF NOT EXISTS "skill_bounties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"estimated_minutes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"posted_by_user_id" text,
	"posted_by_name" text,
	"claimed_by_user_id" text,
	"claimed_by_name" text,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"linked_skill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_bounties" ADD CONSTRAINT "skill_bounties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_bounties_company_status_idx" ON "skill_bounties" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_bounties_claimed_by_idx" ON "skill_bounties" USING btree ("company_id","claimed_by_user_id");
