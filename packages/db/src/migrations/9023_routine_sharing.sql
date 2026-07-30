-- Routines gain EXPLICIT sharing scopes, mirroring what company_skills already does
-- (sharing_scope + sharing_teams + a per-member access table).
--
-- Until now routine visibility was purely DERIVED: a restricted member saw routines
-- assigned to an agent they manage plus routines they created. That has no way to
-- express "share this with another team" or "share this with one colleague".
--
-- How the two interact (deliberate): the explicit scope decides sharing for humans,
-- and the derived agent rule stays as a FLOOR — you never lose sight of the
-- automation belonging to agents you oversee, whatever scope someone sets. So
-- defaulting existing rows to 'private' cannot hide anything that is visible today.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';--> statement-breakpoint
ALTER TABLE routines ADD COLUMN IF NOT EXISTS sharing_teams text[] NOT NULL DEFAULT '{}';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routines_company_visibility_idx" ON "routines" USING btree ("company_id","visibility");--> statement-breakpoint

-- Explicit per-principal grants for 'private' (and any) routines. Users only:
-- agents reach a routine through assignment, not through a share.
CREATE TABLE IF NOT EXISTS "routine_access_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "routine_id" uuid NOT NULL REFERENCES "routines"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL,
  "principal_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_access_members_routine_idx" ON "routine_access_members" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_access_members_principal_idx" ON "routine_access_members" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_access_members_unique" ON "routine_access_members" USING btree ("routine_id","principal_type","principal_id");
