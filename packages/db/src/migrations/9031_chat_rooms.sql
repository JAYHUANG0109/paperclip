-- Per-room chat scope (Phase 1: plumbing only — nothing reads this yet).
-- Promotes a chat space/room from transient plugin KV to a first-class, persisted
-- entity with a stable room_scope_id, so per-room memory (Phase 2, behind a flag)
-- can key on it. Adding this table changes no behaviour on its own.
CREATE TABLE IF NOT EXISTS chat_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  surface text NOT NULL DEFAULT 'google_chat',
  space_name text NOT NULL,
  room_scope_id text NOT NULL,
  space_type text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_company_scope_uq
  ON chat_rooms (company_id, surface, room_scope_id);
CREATE INDEX IF NOT EXISTS chat_rooms_company_scope_idx
  ON chat_rooms (company_id, room_scope_id);
