/** SQL shared by Study and Maintenance Control for the stored index summary of a release. */

/** A native-order extent that exact-key routing may skip; `c` is the coverage row. */
export const ROUTABLE_EXTENT = `typeof(json_extract(c.native_extent_json, '$.order_range[0]')) = 'integer'
  AND typeof(json_extract(c.native_extent_json, '$.order_range[1]')) = 'integer'
  AND json_extract(c.native_extent_json, '$.order_range[0]') >= 0
  AND json_extract(c.native_extent_json, '$.order_range[1]') >= json_extract(c.native_extent_json, '$.order_range[0]')
  AND json_extract(c.native_extent_json, '$.order_range[1]') <= 9007199254740991`;

/** Index output kinds whose coverage the summary stores. */
const INDEX_KINDS = `('source_search', 'word_index')`;

/** Store the summary of one release (`?1`): per source and capability, every index output the
 *  release selects, with what a search needs to choose and report it. Idempotent. */
export const RELEASE_INDEX_SUMMARY = `INSERT OR IGNORE INTO release_index_summary(release_id, source_revision_id, capability, has_routing, outputs_json)
SELECT ?1, c.source_revision_id, c.capability, MAX(routed.output_key IS NOT NULL),
  json_group_array(json_object(
    'id', c.output_id,
    'key', routed.output_key,
    'state', c.state,
    'method', c.method_version,
    'limitation', c.limitation,
    'index_artifact', c.index_artifact_id,
    'first', json_extract(c.native_extent_json, '$.order_range[0]'),
    'last', json_extract(c.native_extent_json, '$.order_range[1]'),
    'routable', CASE WHEN ${ROUTABLE_EXTENT} THEN 1 ELSE 0 END,
    'first_unit', json_extract(c.native_extent_json, '$.unit_ids[0]'),
    'last_unit', json_extract(c.native_extent_json, '$.unit_ids[#-1]'),
    'units', json_array_length(c.native_extent_json, '$.unit_ids'),
    'rule', json_extract(p.parameters_json, '$.normalization_rule')))
FROM release_outputs ro
JOIN prepared_outputs p ON p.id = ro.output_id AND p.kind IN ${INDEX_KINDS}
JOIN coverage c ON c.output_id = ro.output_id
LEFT JOIN index_routes routed ON routed.output_id = ro.output_id
WHERE ro.release_id = ?1
GROUP BY c.source_revision_id, c.capability`;
