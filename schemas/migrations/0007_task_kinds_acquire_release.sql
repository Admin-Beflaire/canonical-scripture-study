-- Maintenance Control: the task kinds `acquire` and `release` join the existing kinds.
-- A CHECK constraint cannot be altered, so the table is rebuilt with the same columns, rows,
-- index and triggers. The rows wait in a holding table while the table is dropped and created
-- again under its own name, so child tables keep their references and the deferred foreign-key
-- check, which runs at the end of the migration's transaction, finds every parent row again.
PRAGMA defer_foreign_keys = true;
CREATE TABLE maintenance_tasks_hold AS SELECT * FROM maintenance_tasks;
DROP TABLE maintenance_tasks;
CREATE TABLE maintenance_tasks (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  requester TEXT NOT NULL CHECK (length(requester) > 0),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'
    AND json_extract(scope_json, '$.kind') IN ('acquire','prepare','correct','replace','release','remove','package','incorporate_statement','rollback','validate_restore')),
  basis_digest TEXT NOT NULL CHECK (length(basis_digest) = 64 AND basis_digest NOT GLOB '*[^0-9a-f]*'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN ('queued','running','paused','blocked','checked','completed','cancelled','superseded')),
  base_release_id TEXT REFERENCES releases(id),
  candidate_release_id TEXT REFERENCES releases(id),
  quality_ref TEXT CHECK (quality_ref IS NULL OR length(quality_ref) > 0),
  scope_ref TEXT CHECK (scope_ref IS NULL OR length(scope_ref) > 0),
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json) AND json_type(outcome_json) = 'object'),
  UNIQUE(requester, request_key)
) STRICT;
INSERT INTO maintenance_tasks SELECT id, requester, request_key, instruction, scope_json, basis_digest, revision, state,
  base_release_id, candidate_release_id, quality_ref, scope_ref, outcome_json FROM maintenance_tasks_hold;
DROP TABLE maintenance_tasks_hold;
CREATE INDEX maintenance_tasks_state ON maintenance_tasks(state);

CREATE TRIGGER maintenance_task_identity_stable BEFORE UPDATE OF id, requester, request_key, instruction, scope_json, basis_digest ON maintenance_tasks
BEGIN SELECT RAISE(ABORT, 'Task identity and scope are immutable'); END;
CREATE TRIGGER maintenance_task_revision_step BEFORE UPDATE ON maintenance_tasks
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'Task revision must advance by one'); END;
CREATE TRIGGER maintenance_task_terminal BEFORE UPDATE ON maintenance_tasks
WHEN OLD.state IN ('completed','cancelled','superseded')
BEGIN SELECT RAISE(ABORT, 'Finished task is immutable'); END;
CREATE TRIGGER maintenance_task_no_delete BEFORE DELETE ON maintenance_tasks
BEGIN SELECT RAISE(ABORT, 'Task records are retained'); END;
