-- Passage lookups seek by the same first native-unit identifier that Preparation records.
CREATE INDEX native_spans_verse_unit ON native_spans(json_extract(segments_json, '$[0].unit_id'))
WHERE kind = 'verse';
