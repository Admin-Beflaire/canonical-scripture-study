-- Maintenance Control private task state. Study never queries these tables.
-- Integrity only: no promotion, approval or dispatch happens here.
CREATE TABLE maintenance_tasks (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  requester TEXT NOT NULL CHECK (length(requester) > 0),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'
    AND json_extract(scope_json, '$.kind') IN ('prepare','correct','replace','remove','package','incorporate_statement','rollback','validate_restore')),
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

CREATE TABLE maintenance_jobs (
  task_id TEXT NOT NULL REFERENCES maintenance_tasks(id),
  task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
  unit_id TEXT NOT NULL CHECK (length(unit_id) BETWEEN 1 AND 200),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('acquire','prepare','quality')),
  input_basis TEXT NOT NULL CHECK (length(input_basis) = 64 AND input_basis NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
  state TEXT NOT NULL CHECK (state IN ('intended','dispatched','running','checkpointed','succeeded','failed','cancelled')),
  checkpoint_ref TEXT CHECK (checkpoint_ref IS NULL OR length(checkpoint_ref) > 0),
  result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) > 0),
  PRIMARY KEY(task_id, unit_id, attempt),
  CHECK (state = 'intended' OR run_id IS NOT NULL)
) STRICT;
CREATE TRIGGER maintenance_job_identity_stable BEFORE UPDATE OF task_id, task_revision, unit_id, attempt, kind, input_basis ON maintenance_jobs
BEGIN SELECT RAISE(ABORT, 'Job identity is immutable'); END;
CREATE TRIGGER maintenance_job_run_stable BEFORE UPDATE OF run_id ON maintenance_jobs
WHEN OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id
BEGIN SELECT RAISE(ABORT, 'Job run identity is immutable'); END;
CREATE TRIGGER maintenance_job_terminal BEFORE UPDATE ON maintenance_jobs
WHEN OLD.state IN ('succeeded','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'Finished job is immutable'); END;

CREATE TABLE maintenance_exclusions (
  source_or_component_id TEXT NOT NULL CHECK (length(source_or_component_id) > 0),
  decision_ref TEXT NOT NULL CHECK (length(decision_ref) > 0),
  task_id TEXT NOT NULL REFERENCES maintenance_tasks(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  PRIMARY KEY(source_or_component_id, decision_ref)
) STRICT;
CREATE INDEX maintenance_exclusions_active ON maintenance_exclusions(active, source_or_component_id);
CREATE TRIGGER maintenance_exclusion_identity_stable BEFORE UPDATE OF source_or_component_id, decision_ref, task_id ON maintenance_exclusions
BEGIN SELECT RAISE(ABORT, 'Exclusion identity is immutable'); END;
CREATE TRIGGER maintenance_exclusion_no_delete BEFORE DELETE ON maintenance_exclusions
BEGIN SELECT RAISE(ABORT, 'Exclusions are retained; deactivate by instruction'); END;
