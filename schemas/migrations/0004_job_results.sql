-- Maintenance Control: keep each accepted job result, so later units receive the exact
-- output references of the units they depend on and the quality unit its candidate.
-- Written once in the same update that records the job's result; finished jobs stay immutable.
ALTER TABLE maintenance_jobs ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
