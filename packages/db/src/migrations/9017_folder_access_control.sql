ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'company' NOT NULL;
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "sharing_teams" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "shared_user_ids" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "created_by_user_id" text;
