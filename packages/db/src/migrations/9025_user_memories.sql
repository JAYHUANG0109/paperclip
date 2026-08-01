-- Personal memory: facts a user (or their agent) wants remembered across runs.
--
-- The DB is the source of truth and a materializer writes these out as files
-- for agents to read, mirroring company skills. An agent editing its own
-- workspace files must never be able to grant itself memory it was not given,
-- and a rebuilt workspace must not lose anything.
--
-- `user_id` is the OWNER and the only input to the access decision: readable by
-- that user, by the agents mapped to them in `agent_memberships`, and by admins
-- read-only. An agent's access follows its MAPPED user, never whoever triggered
-- the run — see server/src/services/personal-memory-access.ts, which is the one
-- place that rule is stated.
--
-- Scoped by company to match `agent_memberships` (company_id, user_id,
-- agent_id), so a user in two companies gets two memories rather than one that
-- bleeds across tenants. `user_id` is text with no FK, matching
-- `agent_memberships.user_id`: the auth user table is managed by better-auth
-- and is not referenced from application tables.
CREATE TABLE IF NOT EXISTS "user_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"memory_type" text DEFAULT 'project' NOT NULL,
	"content" text NOT NULL,
	-- Same convention as agent_memberships.source: anything inserted without
	-- naming a source is treated as hand-made, so an importer reconciling its
	-- own rows can never reclaim one a person wrote.
	"source" text DEFAULT 'manual' NOT NULL,
	-- Relative path within the owner's memory directory, preserved on import so
	-- a folder round-trips with its structure. Null for UI-created entries.
	"file_path" text,
	"is_binary" boolean DEFAULT false NOT NULL,
	"byte_size" integer,
	"sha256" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_company_id_companies_id_fk"
		FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Provenance only, so losing the agent must not lose the memory it wrote.
DO $$ BEGIN
	ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_created_by_agent_id_agents_id_fk"
		FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE set null;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- The hot path: every read is "this owner's memories in this company".
CREATE INDEX IF NOT EXISTS "user_memories_company_user_idx"
	ON "user_memories" ("company_id", "user_id");
--> statement-breakpoint
-- One memory per slug per owner.
CREATE UNIQUE INDEX IF NOT EXISTS "user_memories_company_user_name_uq"
	ON "user_memories" ("company_id", "user_id", "name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memories_source_idx"
	ON "user_memories" ("company_id", "source");
