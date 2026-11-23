-- Use an integer for the output repeated in every aid row and lookup index.
-- The view keeps the public record shape and existing span identities unchanged.
DROP TRIGGER aid_entries_immutable;
DROP TRIGGER aid_entries_insert_selected;
DROP TRIGGER aid_entries_delete_selected;
DROP INDEX aid_entries_lookup;
DROP INDEX aid_entries_entry_key;
ALTER TABLE aid_entries RENAME TO aid_entries_old;

CREATE TABLE aid_output_keys (
  key INTEGER PRIMARY KEY,
  output_id TEXT NOT NULL UNIQUE REFERENCES prepared_outputs(id)
) STRICT;
INSERT INTO aid_output_keys(output_id) SELECT DISTINCT output_id FROM aid_entries_old ORDER BY output_id;

CREATE TABLE aid_entry_rows (
  output_key INTEGER NOT NULL REFERENCES aid_output_keys(key),
  entry INTEGER NOT NULL CHECK (entry BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('lexicon_entry','grammar_expansion','proper_name')),
  entry_key TEXT NOT NULL CHECK (length(entry_key) > 0),
  lookup_key TEXT CHECK (lookup_key IS NULL OR length(lookup_key) > 0),
  byte_offset INTEGER NOT NULL CHECK (byte_offset BETWEEN 0 AND 9007199254740991),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 9007199254740991),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (output_key, entry)
) STRICT, WITHOUT ROWID;
INSERT INTO aid_entry_rows SELECT k.key, e.entry, e.kind, e.entry_key, e.lookup_key, e.byte_offset, e.byte_length, e.sha256
FROM aid_entries_old e JOIN aid_output_keys k ON k.output_id = e.output_id;
DROP TABLE aid_entries_old;
CREATE INDEX aid_entries_lookup ON aid_entry_rows(kind, lookup_key, output_key, entry) WHERE lookup_key IS NOT NULL;
CREATE INDEX aid_entries_entry_key ON aid_entry_rows(entry_key, output_key, entry) WHERE kind = 'lexicon_entry';

CREATE VIEW aid_entries AS
SELECT k.output_id, e.entry, e.kind, e.entry_key, e.lookup_key, e.byte_offset, e.byte_length, e.sha256
FROM aid_entry_rows e JOIN aid_output_keys k ON k.key = e.output_key;
CREATE TRIGGER aid_entries_insert INSTEAD OF INSERT ON aid_entries BEGIN
  INSERT INTO aid_output_keys(output_id) VALUES (NEW.output_id) ON CONFLICT(output_id) DO NOTHING;
  INSERT INTO aid_entry_rows VALUES ((SELECT key FROM aid_output_keys WHERE output_id = NEW.output_id), NEW.entry,
    NEW.kind, NEW.entry_key, NEW.lookup_key, NEW.byte_offset, NEW.byte_length, NEW.sha256);
END;
CREATE TRIGGER aid_entries_delete INSTEAD OF DELETE ON aid_entries BEGIN
  DELETE FROM aid_entry_rows WHERE output_key = (SELECT key FROM aid_output_keys WHERE output_id = OLD.output_id)
    AND entry = OLD.entry;
  DELETE FROM aid_output_keys WHERE output_id = OLD.output_id
    AND NOT EXISTS (SELECT 1 FROM aid_entry_rows WHERE output_key = aid_output_keys.key);
END;
CREATE TRIGGER aid_entries_immutable INSTEAD OF UPDATE ON aid_entries
BEGIN SELECT RAISE(ABORT, 'Prepared aid entries are immutable'); END;
CREATE TRIGGER aid_entry_rows_insert_selected BEFORE INSERT ON aid_entry_rows
WHEN EXISTS (SELECT 1 FROM aid_output_keys k JOIN release_outputs ro ON ro.output_id = k.output_id
  JOIN release_selection rs ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE k.key = NEW.output_key)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;
CREATE TRIGGER aid_entry_rows_delete_selected BEFORE DELETE ON aid_entry_rows
WHEN EXISTS (SELECT 1 FROM aid_output_keys k JOIN release_outputs ro ON ro.output_id = k.output_id
  JOIN release_selection rs ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE k.key = OLD.output_key)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;
CREATE TRIGGER aid_entry_rows_immutable BEFORE UPDATE ON aid_entry_rows
BEGIN SELECT RAISE(ABORT, 'Prepared aid entries are immutable'); END;
CREATE TRIGGER aid_output_keys_immutable BEFORE UPDATE ON aid_output_keys
BEGIN SELECT RAISE(ABORT, 'Prepared output keys are immutable'); END;
