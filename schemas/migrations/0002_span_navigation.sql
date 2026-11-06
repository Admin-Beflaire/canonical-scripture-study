-- Inclusive source-order intervals are navigation aids, not native text offsets.
CREATE UNIQUE INDEX native_spans_navigation_identity ON native_spans(id, source_revision_id, kind);
CREATE TABLE span_segments (
  span_id TEXT NOT NULL,
  segment_ordinal INTEGER NOT NULL CHECK (segment_ordinal BETWEEN 0 AND 9007199254740991),
  source_revision_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_order INTEGER NOT NULL CHECK (start_order BETWEEN 0 AND 9007199254740991),
  end_order INTEGER NOT NULL CHECK (end_order BETWEEN start_order AND 9007199254740991),
  PRIMARY KEY(span_id, segment_ordinal),
  FOREIGN KEY(span_id, source_revision_id, kind) REFERENCES native_spans(id, source_revision_id, kind)
) STRICT;
CREATE INDEX span_segments_source_kind_order ON span_segments(source_revision_id, kind, start_order, end_order, span_id);
CREATE TRIGGER span_segments_ordinal BEFORE INSERT ON span_segments
WHEN NEW.segment_ordinal >= (SELECT json_array_length(segments_json) FROM native_spans WHERE id=NEW.span_id)
BEGIN SELECT RAISE(ABORT, 'Navigation segment ordinal is outside its native span'); END;
CREATE TRIGGER span_segments_immutable BEFORE UPDATE ON span_segments
BEGIN SELECT RAISE(ABORT, 'Prepared navigation records are immutable'); END;
CREATE TRIGGER span_segments_insert_selected BEFORE INSERT ON span_segments
WHEN EXISTS (
  SELECT 1 FROM native_spans ns JOIN release_outputs ro ON ro.output_id=ns.output_id
  JOIN release_selection rs ON ro.release_id IN (rs.current_release_id,rs.previous_release_id)
  WHERE ns.id=NEW.span_id
)
BEGIN SELECT RAISE(ABORT, 'Selected navigation rows are immutable'); END;
CREATE TRIGGER span_segments_delete_selected BEFORE DELETE ON span_segments
WHEN EXISTS (
  SELECT 1 FROM native_spans ns JOIN release_outputs ro ON ro.output_id=ns.output_id
  JOIN release_selection rs ON ro.release_id IN (rs.current_release_id,rs.previous_release_id)
  WHERE ns.id=OLD.span_id
)
BEGIN SELECT RAISE(ABORT, 'Selected navigation rows are immutable'); END;
