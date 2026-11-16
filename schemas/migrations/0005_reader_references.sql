-- Reader navigation is separate from native spans and textual relationships.
CREATE TABLE reader_reference_bases (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  reader_scheme_version TEXT NOT NULL CHECK (length(reader_scheme_version) > 0),
  native_scheme_version TEXT NOT NULL CHECK (length(native_scheme_version) > 0),
  checked_extent_json TEXT NOT NULL CHECK (
    json_valid(checked_extent_json) AND json_type(checked_extent_json) = 'object' AND
    json_type(checked_extent_json, '$.ranges') IS 'array' AND json_array_length(checked_extent_json, '$.ranges') > 0),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object')
) STRICT;
CREATE INDEX reader_reference_bases_lookup ON reader_reference_bases(source_revision_id, reader_scheme_version, output_id);
CREATE INDEX reader_reference_bases_output ON reader_reference_bases(output_id);

CREATE TABLE reader_reference_links (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  reader_scheme_version TEXT NOT NULL CHECK (length(reader_scheme_version) > 0),
  reader_ref TEXT NOT NULL CHECK (length(reader_ref) > 0),
  span_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('numbered_text','superscription')),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('exact','partial','reordered','composite','ambiguous','missing','unresolved')),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  gap_reason TEXT,
  CHECK (role <> 'superscription' OR reader_ref GLOB '*.1'),
  CHECK ((status IN ('ambiguous','missing','unresolved') AND span_id IS NULL AND gap_reason IS NOT NULL AND length(gap_reason) > 0) OR
         (status IN ('exact','partial','reordered','composite') AND span_id IS NOT NULL AND gap_reason IS NULL)),
  FOREIGN KEY(span_id, source_revision_id) REFERENCES native_spans(id, source_revision_id),
  UNIQUE(source_revision_id, reader_scheme_version, reader_ref, output_id, role, ordinal)
) STRICT;
CREATE INDEX reader_reference_links_output ON reader_reference_links(output_id);
CREATE INDEX reader_reference_links_span ON reader_reference_links(span_id, source_revision_id);

CREATE TRIGGER reader_reference_bases_insert_guard BEFORE INSERT ON reader_reference_bases
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) IS NOT 'source_revision'
  OR EXISTS (SELECT 1 FROM release_outputs WHERE output_id = NEW.output_id)
BEGIN SELECT RAISE(ABORT, 'Reader reference bases must name a source revision and precede release membership'); END;

CREATE TRIGGER reader_reference_links_insert_guard BEFORE INSERT ON reader_reference_links
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) IS NOT 'source_revision'
  OR EXISTS (SELECT 1 FROM release_outputs WHERE output_id = NEW.output_id)
  OR (NEW.span_id IS NOT NULL AND NEW.role = 'superscription' AND
      (SELECT kind FROM native_spans WHERE id = NEW.span_id) IS NOT 'superscription')
BEGIN SELECT RAISE(ABORT, 'Invalid reader-reference link or output already belongs to a release'); END;

CREATE TRIGGER reader_reference_bases_immutable BEFORE UPDATE ON reader_reference_bases
BEGIN SELECT RAISE(ABORT, 'Prepared reader references are immutable'); END;
CREATE TRIGGER reader_reference_links_immutable BEFORE UPDATE ON reader_reference_links
BEGIN SELECT RAISE(ABORT, 'Prepared reader references are immutable'); END;

CREATE TRIGGER reader_reference_bases_delete_selected BEFORE DELETE ON reader_reference_bases
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
  ON ro.release_id IN (rs.current_release_id, rs.previous_release_id) WHERE ro.output_id = OLD.output_id)
BEGIN SELECT RAISE(ABORT, 'Selected reader references are immutable'); END;

CREATE TRIGGER reader_reference_links_delete_selected BEFORE DELETE ON reader_reference_links
WHEN EXISTS (
  SELECT 1 FROM release_outputs ro JOIN release_selection rs
  ON ro.release_id IN (rs.current_release_id, rs.previous_release_id) WHERE ro.output_id = OLD.output_id)
BEGIN SELECT RAISE(ABORT, 'Selected reader references are immutable'); END;

CREATE TRIGGER release_reader_scheme_version_guard BEFORE INSERT ON release_outputs
WHEN EXISTS (
  SELECT 1 FROM reader_reference_bases b JOIN releases r ON r.id = NEW.release_id
  WHERE b.output_id = NEW.output_id
    AND json_extract(r.schema_versions_json, '$.reader_scheme_version') IS NOT b.reader_scheme_version)
  OR EXISTS (
  SELECT 1 FROM reader_reference_links l JOIN releases r ON r.id = NEW.release_id
  WHERE l.output_id = NEW.output_id
    AND json_extract(r.schema_versions_json, '$.reader_scheme_version') IS NOT l.reader_scheme_version)
BEGIN SELECT RAISE(ABORT, 'Reader-reference output requires the matching release catalogue version'); END;
