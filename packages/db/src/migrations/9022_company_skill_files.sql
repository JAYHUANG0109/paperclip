-- DB-backed per-file content for company skills, so the DB is the single source
-- of truth for a skill's full file set (SKILL.md + references/scripts/assets) —
-- not just SKILL.md (company_skills.markdown). Runtime materialization and the
-- skill-file reader prefer a row here when present; otherwise they fall back to
-- the legacy on-disk source_locator copy (additive + backward-compatible).
CREATE TABLE IF NOT EXISTS company_skill_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  skill_id uuid NOT NULL REFERENCES company_skills(id) ON DELETE CASCADE,
  path text NOT NULL,
  kind text NOT NULL,
  content text NOT NULL,
  is_binary boolean NOT NULL DEFAULT false,
  byte_size integer,
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS company_skill_files_skill_path_uq ON company_skill_files (skill_id, path);
CREATE INDEX IF NOT EXISTS company_skill_files_skill_idx ON company_skill_files (skill_id);
CREATE INDEX IF NOT EXISTS company_skill_files_company_idx ON company_skill_files (company_id);
