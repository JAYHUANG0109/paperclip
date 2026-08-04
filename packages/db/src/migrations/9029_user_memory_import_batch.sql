-- Group memories created in one import/paste action into a "batch" so the UI can
-- show import history and select/delete a whole batch at once.
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS import_batch_id text;
CREATE INDEX IF NOT EXISTS user_memories_import_batch_idx
  ON user_memories (company_id, user_id, import_batch_id);
