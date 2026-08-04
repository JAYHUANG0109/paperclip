-- Optional per-task skill scoping: the equipped skills the assignee agent should
-- use for this task (an array of skill keys). Empty/null = no restriction.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS skill_hints jsonb;
