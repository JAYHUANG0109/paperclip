-- Team-scoped projects can now target MULTIPLE teams (not just one). Add a
-- `teams` array alongside the legacy single `team` column; authz matches against
-- `teams` when present, else falls back to `team`. Backfill existing team labels
-- so nothing regresses.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS teams jsonb;
UPDATE projects SET teams = jsonb_build_array(team) WHERE team IS NOT NULL AND teams IS NULL;
