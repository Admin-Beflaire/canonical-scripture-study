-- The statement record holds the approved wording itself, so Study can supply it with
-- the conclusion check. An approved statement cannot be saved without its wording.
ALTER TABLE character_statements ADD COLUMN wording TEXT
  CHECK (status <> 'approved' OR (wording IS NOT NULL AND length(wording) > 0));
