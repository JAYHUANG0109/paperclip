-- Per-room memory store (#4 Phase 2, approach B). Separate from user_memories so
-- the fails-closed personal-memory model is untouched. Nothing writes here unless
-- the room-memory feature flag is on, so adding it changes no behaviour.
CREATE TABLE IF NOT EXISTS room_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_scope_id text NOT NULL,
  surface text NOT NULL DEFAULT 'google_chat',
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  memory_type text NOT NULL DEFAULT 'project',
  content text NOT NULL,
  source text NOT NULL DEFAULT 'agent',
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  times_observed integer NOT NULL DEFAULT 1,
  last_observed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_memories_company_room_idx ON room_memories (company_id, room_scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS room_memories_company_room_name_uq
  ON room_memories (company_id, room_scope_id, name) WHERE deleted_at IS NULL;
