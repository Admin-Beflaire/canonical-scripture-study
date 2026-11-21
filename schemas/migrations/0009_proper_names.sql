-- TIPNR identity candidates by the full source tag; words remain in private R2.
CREATE INDEX annotations_proper_name_tag ON annotations(
  json_extract(details_json, '$.disambiguated_strong'), output_id, span_id
) WHERE kind = 'proper_name';
