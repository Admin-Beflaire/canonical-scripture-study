-- A unit no longer saves a checkpoint: a failed unit reruns as a new attempt, so the job rows
-- no longer record one. The 'checkpointed' state stays allowed by the table constraint (never
-- written; removing it would rebuild the table).
ALTER TABLE maintenance_jobs DROP COLUMN checkpoint_ref;
