-- Keep existing jobs and their receipts while adding the analysis unit kind.
CREATE TABLE maintenance_jobs_next (
  task_id TEXT NOT NULL REFERENCES maintenance_tasks(id),
  task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
  unit_id TEXT NOT NULL CHECK (length(unit_id) BETWEEN 1 AND 200),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('acquire','prepare','quality','analyse')),
  input_basis TEXT NOT NULL CHECK (length(input_basis) = 64 AND input_basis NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) > 0),
  state TEXT NOT NULL CHECK (state IN ('intended','dispatched','running','checkpointed','succeeded','failed','cancelled')),
  result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) > 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  PRIMARY KEY(task_id, unit_id, attempt),
  CHECK (state IN ('intended','cancelled') OR run_id IS NOT NULL)
) STRICT;
INSERT INTO maintenance_jobs_next (
  task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, result_ref, result_json
)
SELECT task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, result_ref, result_json
FROM maintenance_jobs;
DROP TABLE maintenance_jobs;
ALTER TABLE maintenance_jobs_next RENAME TO maintenance_jobs;
CREATE TRIGGER maintenance_job_identity_stable BEFORE UPDATE OF task_id, task_revision, unit_id, attempt, kind, input_basis ON maintenance_jobs
BEGIN SELECT RAISE(ABORT, 'Job identity is immutable'); END;
CREATE TRIGGER maintenance_job_run_stable BEFORE UPDATE OF run_id ON maintenance_jobs
WHEN OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id
BEGIN SELECT RAISE(ABORT, 'Job run identity is immutable'); END;
CREATE TRIGGER maintenance_job_terminal BEFORE UPDATE ON maintenance_jobs
WHEN OLD.state IN ('succeeded','failed','cancelled')
BEGIN SELECT RAISE(ABORT, 'Finished job is immutable'); END;
