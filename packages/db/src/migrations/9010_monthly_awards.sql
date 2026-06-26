CREATE TABLE IF NOT EXISTS "monthly_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period_month" text NOT NULL,
	"award_key" text NOT NULL,
	"winner_user_id" text,
	"winner_name" text,
	"value" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_awards" ADD CONSTRAINT "monthly_awards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monthly_awards_company_period_idx" ON "monthly_awards" USING btree ("company_id","period_month");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_awards_unique" ON "monthly_awards" USING btree ("company_id","period_month","award_key");
