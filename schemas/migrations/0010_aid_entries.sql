-- P3: language-aid entries leave D1. One small row per entry points into the output's
-- entries file in private R2 (the entry's metadata and wording, one line per entry);
-- the row carries only the lookup keys and the line's position and digest.
CREATE TABLE aid_entries (
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  entry INTEGER NOT NULL CHECK (entry BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('lexicon_entry','grammar_expansion','proper_name')),
  entry_key TEXT NOT NULL CHECK (length(entry_key) > 0),
  lookup_key TEXT CHECK (lookup_key IS NULL OR length(lookup_key) > 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset BETWEEN 0 AND 9007199254740991),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 9007199254740991),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (output_id, entry)
) STRICT, WITHOUT ROWID;
CREATE INDEX aid_entries_lookup ON aid_entries(kind, lookup_key, output_id, entry) WHERE lookup_key IS NOT NULL;
CREATE INDEX aid_entries_entry_key ON aid_entries(entry_key, output_id, entry) WHERE kind = 'lexicon_entry';

CREATE TRIGGER aid_entries_immutable BEFORE UPDATE ON aid_entries
BEGIN SELECT RAISE(ABORT, 'Prepared aid entries are immutable'); END;

CREATE TRIGGER aid_entries_insert_selected BEFORE INSERT ON aid_entries
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
    ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = NEW.output_id
)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;

CREATE TRIGGER aid_entries_delete_selected BEFORE DELETE ON aid_entries
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
    ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = OLD.output_id
)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;
