-- Phase 3: per-project instructions/context. Freeform prose an agent reads when
-- it works on a task belonging to this project (surfaced via heartbeat-context).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructions text;
