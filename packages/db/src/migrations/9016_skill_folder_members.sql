ALTER TABLE "company_skill_folders" ADD COLUMN IF NOT EXISTS "shared_user_ids" text[] DEFAULT '{}' NOT NULL;
