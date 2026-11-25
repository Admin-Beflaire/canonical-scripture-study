-- One stored summary per release, source and capability of the index outputs the release selects,
-- so a search reads one row instead of scanning every output's coverage, membership and route
-- rows. The database writes it when a release becomes the current or previous one, from the
-- members, coverage and routes that release holds; they are immutable from then on.
-- A release without a summary row keeps the full scan.
CREATE TABLE release_index_summary (
  release_id TEXT NOT NULL REFERENCES releases(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  capability TEXT NOT NULL,
  has_routing INTEGER NOT NULL CHECK (has_routing IN (0, 1)),
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json) AND json_type(outputs_json) = 'array'),
  PRIMARY KEY (release_id, source_revision_id, capability)
) STRICT, WITHOUT ROWID;

-- Index outputs are the 'source_search' and 'word_index' kinds. 'routable' marks a native-order
-- extent that exact-key routing may skip (the rule Study's full scan uses).
CREATE TRIGGER release_index_summary_on_selection AFTER UPDATE OF current_release_id, previous_release_id ON release_selection
BEGIN
  INSERT OR IGNORE INTO release_index_summary(release_id, source_revision_id, capability, has_routing, outputs_json)
  SELECT ro.release_id, c.source_revision_id, c.capability, MAX(routed.output_key IS NOT NULL),
    json_group_array(json_object(
      'id', c.output_id,
      'key', routed.output_key,
      'state', c.state,
      'method', c.method_version,
      'limitation', c.limitation,
      'index_artifact', c.index_artifact_id,
      'first', json_extract(c.native_extent_json, '$.order_range[0]'),
      'last', json_extract(c.native_extent_json, '$.order_range[1]'),
      'routable', CASE WHEN typeof(json_extract(c.native_extent_json, '$.order_range[0]')) = 'integer'
        AND typeof(json_extract(c.native_extent_json, '$.order_range[1]')) = 'integer'
        AND json_extract(c.native_extent_json, '$.order_range[0]') >= 0
        AND json_extract(c.native_extent_json, '$.order_range[1]') >= json_extract(c.native_extent_json, '$.order_range[0]')
        AND json_extract(c.native_extent_json, '$.order_range[1]') <= 9007199254740991 THEN 1 ELSE 0 END,
      'first_unit', json_extract(c.native_extent_json, '$.unit_ids[0]'),
      'last_unit', json_extract(c.native_extent_json, '$.unit_ids[#-1]'),
      'units', json_array_length(c.native_extent_json, '$.unit_ids'),
      'rule', json_extract(p.parameters_json, '$.normalization_rule')))
  FROM release_outputs ro
  JOIN prepared_outputs p ON p.id = ro.output_id AND p.kind IN ('source_search', 'word_index')
  JOIN coverage c ON c.output_id = ro.output_id
  LEFT JOIN index_routes routed ON routed.output_id = ro.output_id
  WHERE ro.release_id IN (NEW.current_release_id, NEW.previous_release_id)
  GROUP BY ro.release_id, c.source_revision_id, c.capability;
END;

-- Store the summary of the releases selected now. The update changes nothing in the selection;
-- it only fires the trigger.
UPDATE release_selection SET current_release_id = current_release_id;
