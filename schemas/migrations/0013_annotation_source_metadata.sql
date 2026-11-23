-- Store the provider and basis of textual-variant notes once per source revision.
-- Keep the evidence record shape for preparation, validation and readers.
DROP TRIGGER annotations_revision_insert;
DROP TRIGGER annotations_revision_update;
DROP TRIGGER annotations_immutable;
DROP TRIGGER annotations_delete_selected;
DROP TRIGGER annotations_insert_selected;
DROP INDEX annotations_span;
DROP INDEX annotations_output;
ALTER TABLE annotations RENAME TO annotations_old;

CREATE TABLE annotation_source_metadata (
  id INTEGER PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  provider TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  UNIQUE(source_revision_id, provider, basis_json),
  UNIQUE(id, source_revision_id)
) STRICT;

CREATE TABLE annotation_rows (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  span_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT,
  basis_json TEXT CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  metadata_id INTEGER,
  CHECK ((kind = 'textual_variants' AND metadata_id IS NOT NULL AND provider IS NULL AND basis_json IS NULL)
    OR (kind <> 'textual_variants' AND metadata_id IS NULL AND provider IS NOT NULL AND basis_json IS NOT NULL)),
  FOREIGN KEY(metadata_id, source_revision_id) REFERENCES annotation_source_metadata(id, source_revision_id),
  FOREIGN KEY(span_id, source_revision_id) REFERENCES native_spans(id, source_revision_id)
) STRICT;
CREATE INDEX annotations_output ON annotation_rows(output_id, span_id);
CREATE INDEX annotations_span ON annotation_rows(span_id, source_revision_id, kind);

CREATE VIEW annotations AS
SELECT a.id, a.output_id, a.source_revision_id, a.span_id, a.kind,
  COALESCE(m.provider, a.provider) AS provider, COALESCE(m.basis_json, a.basis_json) AS basis_json, a.details_json
FROM annotation_rows a LEFT JOIN annotation_source_metadata m ON m.id = a.metadata_id;

CREATE TRIGGER annotations_insert INSTEAD OF INSERT ON annotations BEGIN
  INSERT INTO annotation_source_metadata(source_revision_id, provider, basis_json)
  SELECT NEW.source_revision_id, NEW.provider, NEW.basis_json WHERE NEW.kind = 'textual_variants'
  ON CONFLICT(source_revision_id, provider, basis_json) DO NOTHING;
  INSERT INTO annotation_rows
  SELECT NEW.id, NEW.output_id, NEW.source_revision_id, NEW.span_id, NEW.kind,
    CASE WHEN NEW.kind <> 'textual_variants' THEN NEW.provider END,
    CASE WHEN NEW.kind <> 'textual_variants' THEN NEW.basis_json END, NEW.details_json,
    CASE WHEN NEW.kind = 'textual_variants' THEN (SELECT id FROM annotation_source_metadata
      WHERE source_revision_id = NEW.source_revision_id AND provider = NEW.provider AND basis_json = NEW.basis_json) END;
END;

INSERT INTO annotation_source_metadata(source_revision_id, provider, basis_json)
SELECT DISTINCT source_revision_id, provider, basis_json FROM annotations_old WHERE kind = 'textual_variants';

INSERT INTO annotation_rows
SELECT a.id, a.output_id, a.source_revision_id, a.span_id, a.kind,
  CASE WHEN m.id IS NULL THEN a.provider END,
  CASE WHEN m.id IS NULL THEN a.basis_json END, a.details_json, m.id
FROM annotations_old a LEFT JOIN annotation_source_metadata m
  ON a.kind = 'textual_variants' AND m.source_revision_id = a.source_revision_id
  AND m.provider = a.provider AND m.basis_json = a.basis_json;
DROP TABLE annotations_old;

CREATE TRIGGER annotations_delete INSTEAD OF DELETE ON annotations BEGIN
  DELETE FROM annotation_rows WHERE id = OLD.id;
END;
CREATE TRIGGER annotations_update INSTEAD OF UPDATE ON annotations
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;
CREATE TRIGGER annotation_source_metadata_immutable BEFORE UPDATE ON annotation_source_metadata
BEGIN SELECT RAISE(ABORT, 'Prepared evidence metadata is immutable'); END;

CREATE TRIGGER annotations_revision_insert BEFORE INSERT ON annotation_rows
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER annotations_immutable BEFORE UPDATE ON annotation_rows
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;

CREATE TRIGGER annotations_delete_selected BEFORE DELETE ON annotation_rows
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
    ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = OLD.output_id
)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;

CREATE TRIGGER annotations_insert_selected BEFORE INSERT ON annotation_rows
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
    ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = NEW.output_id
)
BEGIN SELECT RAISE(ABORT, 'Selected output rows are immutable'); END;
