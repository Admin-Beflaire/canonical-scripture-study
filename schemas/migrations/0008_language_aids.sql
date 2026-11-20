-- B2 language aids: small attributed entry metadata in existing annotations.
-- Complete article and morphology-description bodies remain in private R2.
-- The source revision and output membership are always checked by Study.
CREATE INDEX annotations_lexicon_entry_key ON annotations(
  json_extract(details_json, '$.entry_key'), output_id, span_id
) WHERE kind = 'lexicon_entry';
CREATE INDEX annotations_lexicon_strong_base ON annotations(
  json_extract(details_json, '$.strong_base'), output_id, span_id
) WHERE kind = 'lexicon_entry';
CREATE INDEX annotations_grammar_code ON annotations(
  json_extract(details_json, '$.code'), output_id, span_id
) WHERE kind = 'grammar_expansion';
