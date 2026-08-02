-- Personal memory lifecycle: deletion becomes reversible, and capture becomes
-- something the owner can switch off.
--
-- Both are the same idea from two directions. Memory is only worth having if
-- the person it describes is in control of it, and "in control" means being
-- able to undo a hasty delete and being able to say "stop writing for now"
-- without deleting anything.

ALTER TABLE "user_memories"
  ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

-- Partial index: every read filters to the live rows, and the deleted set is a
-- small tail that only the recovery view ever asks for.
CREATE INDEX IF NOT EXISTS "user_memories_company_user_live_idx"
  ON "user_memories" ("company_id", "user_id")
  WHERE "deleted_at" IS NULL;

-- The unique slug constraint has to ignore deleted rows, or a deleted memory
-- would permanently reserve its own name and re-saving the same fact would fail
-- with a constraint error instead of simply recreating it.
DROP INDEX IF EXISTS "user_memories_company_user_name_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "user_memories_company_user_name_uq"
  ON "user_memories" ("company_id", "user_id", "name")
  WHERE "deleted_at" IS NULL;

-- Per-owner capture switch.
--
-- A separate table rather than a column on a users table: memory is scoped by
-- (company, user) exactly like `agent_memberships`, so the switch has to be too.
-- Absence of a row means enabled — capture is on by default, and a user who has
-- never opened the page should not need a row to exist for their agents to work.
CREATE TABLE IF NOT EXISTS "user_memory_settings" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  -- False means agents may not write. The owner always can: pausing capture is
  -- about what is inferred about you, not about your own notes.
  "capture_enabled" boolean NOT NULL DEFAULT true,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("company_id", "user_id")
);
