-- Provenance for agent↔user mappings.
--
-- `agent_memberships` is the canonical mapping that authorization reads
-- (getVisibleAgentIdsForUser) and that personal-memory ownership keys off. Rows
-- can arrive two ways: reconciled from the Google Chat plugin's 代理指派
-- assignment map, or created directly in Paperclip.
--
-- Without provenance a reconciler cannot tell them apart, so removing an
-- assignment in the plugin could only be reflected by deleting rows it does not
-- own — silently destroying mappings created in Paperclip. This column lets the
-- reconciler manage exactly its own rows and leave everything else untouched.
--
-- Default 'manual' is deliberate: anything that already exists, or that any
-- other code path inserts without naming a source, is treated as hand-made and
-- is therefore never reclaimed by the reconciler.
ALTER TABLE "agent_memberships"
	ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
-- Reconciler sweeps select by (company, source); the partial index keeps that
-- cheap without weighing on the common membership lookups.
CREATE INDEX IF NOT EXISTS "agent_memberships_source_idx"
	ON "agent_memberships" ("company_id", "source");
