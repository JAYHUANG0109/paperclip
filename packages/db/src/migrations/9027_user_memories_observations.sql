-- How often a memory has been re-observed.
--
-- Repetition is the signal that separates a standing fact from a passing
-- remark: something an agent notices once may be an accident of one
-- conversation, something it arrives at three times is how the person actually
-- works. Storing the count lets the owner see WHY an entry is there, and gives
-- a later ranking pass something better than recency to sort on.
--
-- Only agent re-writes bump it. A person editing their own memory is correcting
-- it, not confirming it again, and counting that would make the number mean two
-- different things.
--
-- Backfills to 1, which is true of every existing row: each was written once.
ALTER TABLE "user_memories"
	ADD COLUMN IF NOT EXISTS "times_observed" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- The last time an agent confirmed this, as opposed to updated_at, which also
-- moves when the owner edits the text. Null until an agent has re-observed it.
ALTER TABLE "user_memories"
	ADD COLUMN IF NOT EXISTS "last_observed_at" timestamp with time zone;
