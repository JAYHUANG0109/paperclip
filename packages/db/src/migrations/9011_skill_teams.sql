ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "sharing_teams" text[] DEFAULT '{}' NOT NULL;
