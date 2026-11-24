import {isIdentifier, isSafeCount} from './bytes.ts';
import {ReadError} from './states.ts';

/** The only D1 statements Study runs. Every statement is a fixed SELECT whose first
 *  parameter is the current release ID and which reaches evidence rows only through
 *  `release_outputs` membership. Hosts never supply SQL, table names or object keys.
 *  The final parameter is always the row limit (one more than returned, to detect more). */
interface Declaration<I> {
  sql: string;
  params(input: I): unknown[];
}

const MAX_LIST = 20;
/** Candidate verse units for one passage read: three chapters of candidates. */
export const MAX_UNITS = 540;
const list = (value: unknown, max = MAX_LIST): string[] => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > max ||
    !value.every(v => isIdentifier(v)) ||
    new Set(value).size !== value.length
  )
    throw new ReadError(
      'invalid_request',
      'Expected a short list of distinct identifiers',
    );
  return value as string[];
};
const id = (value: unknown): string => {
  if (!isIdentifier(value))
    throw new ReadError('invalid_request', 'Expected an identifier');
  return value;
};
const optionalAfter = (value: unknown, size: number): unknown[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    !value.every(
      v => v === '' || v === -1 || isIdentifier(v, 1024) || isSafeCount(v),
    )
  )
    throw new ReadError('invalid_request', 'Invalid query position');
  return value;
};
const key = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 300 ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw new ReadError('invalid_request', 'Invalid search key');
  return value;
};
const order = (value: unknown): number => {
  if (!isSafeCount(value))
    throw new ReadError('invalid_request', 'Expected a native order');
  return value;
};

export interface SpansInput {
  ids: string[];
}
export interface OverlapInput {
  source_revision_id: string;
  kinds: string[];
  start: number;
  end: number;
  after?: [number, string, number] | null;
}
export interface AnnotationsInput {
  span_ids: string[];
  after?: [string, string] | null;
}
export interface StatementInput {
  [key: string]: never;
}
interface LinkedAidInput {
  keys: [string, string][];
}
export interface LanguageAidInput {
  key: string;
  after?: [string, number] | null;
}
export interface ReleaseSourcesInput {
  capability?: string | null;
  after?: [string, string] | null;
}
export interface UnitPresenceInput {
  units: string[];
  sources?: string[] | null;
}
export interface UnitSpansInput {
  units: string[];
  sources?: string[] | null;
  after?: [string, number] | null;
}
export interface IndexFilesInput {
  source_revision_ids: string[];
  capability: string;
  key: string;
  after?: [string, number, string] | null;
}
export interface IndexSourcesInput {
  source_revision_ids: string[];
  capability: string;
}
export interface ReaderMappingInput {
  references: {
    ref: string;
    book: string;
    chapter: number;
    verse: number;
    native_units: string[];
  }[];
  scheme: string;
  sources: string[] | null;
  after?: [number, string, number, number, string, string] | null;
}
export interface LiteraryContextInput extends Omit<
  ReaderMappingInput,
  'after'
> {
  after?: [string, string] | null;
  include_current?: boolean;
}

const SPANS = `SELECT n.id, n.output_id, n.source_revision_id, n.parent_id, n.kind, n.label, n.native_order,
  n.coordinate_version, n.segments_json, n.basis_json, n.content_id, n.body_ranges_json, n.reading_kind,
  p.exact_text, s.name AS source_name, s.attribution AS source_attribution,
  (SELECT json_group_array(json_object('id', a.id, 'sha256', a.sha256, 'byte_count', a.byte_count,
      'format', a.format, 'registered_locator', a.registered_locator))
    FROM artifacts a CROSS JOIN release_outputs ra ON ra.output_id = a.output_id AND ra.release_id = ?1
    WHERE a.id IN (SELECT json_extract(b.value, '$.artifact_id') FROM json_each(n.body_ranges_json) AS b)) AS body_artifacts_json
FROM json_each(?2) requested
CROSS JOIN native_spans n ON n.id = requested.value
CROSS JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
CROSS JOIN source_nodes s ON s.id = n.source_revision_id
LEFT JOIN text_payloads p ON p.content_id = n.content_id
ORDER BY n.source_revision_id, n.native_order, n.id
LIMIT ?3`;

const OVERLAP = `SELECT g.span_id, g.segment_ordinal, g.kind, g.start_order, g.end_order,
  n.label, n.native_order, n.basis_json, n.source_revision_id
FROM span_segments g
JOIN native_spans n ON n.id = g.span_id
JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
WHERE g.source_revision_id = ?2 AND g.kind IN (SELECT value FROM json_each(?3))
  AND g.start_order <= ?5 AND g.end_order >= ?4
  AND (g.start_order, g.span_id, g.segment_ordinal) > (?6, ?7, ?8)
ORDER BY g.start_order, g.span_id, g.segment_ordinal
LIMIT ?9`;

const ANNOTATIONS = `SELECT a.id, a.span_id, a.source_revision_id, a.kind, a.provider, a.basis_json, a.details_json
FROM annotations a
JOIN release_outputs ro ON ro.output_id = a.output_id AND ro.release_id = ?1
WHERE a.span_id IN (SELECT value FROM json_each(?2)) AND (a.span_id, a.id) > (?3, ?4)
ORDER BY a.span_id, a.id
LIMIT ?5`;

/** Exact source entries only: the host never supplies a SQL field or an object path. One small row
 *  per entry says where its line is in the output's entries file; the line holds the wording. */
const languageAidQuery = (
  kind: 'lexicon_entry' | 'grammar_expansion' | 'proper_name',
  field: 'lookup_key' | 'entry_key',
) => `
SELECT k.output_id, e.entry, e.kind, e.entry_key, e.byte_offset, e.byte_length, e.sha256 AS line_sha256,
  a.id AS artifact_id, a.sha256, a.byte_count, a.format, a.registered_locator, a.source_revision_id,
  s.name AS source_name, s.attribution AS source_attribution,
  json_extract(o.native_extent_json, '$.coordinate_version') AS coordinate_version
FROM aid_output_keys k
CROSS JOIN aid_entry_rows e INDEXED BY aid_entries_${field === 'entry_key' ? 'entry_key' : 'lookup'} ON e.output_key = k.key
CROSS JOIN release_outputs ro ON ro.output_id = k.output_id AND ro.release_id = ?1
CROSS JOIN prepared_outputs o ON o.id = k.output_id
CROSS JOIN coverage c ON c.output_id = k.output_id AND c.capability = e.kind
CROSS JOIN artifacts a ON a.id = c.index_artifact_id
CROSS JOIN source_nodes s ON s.id = a.source_revision_id
WHERE e.kind = '${kind}' AND e.${field} = ?2 AND (k.output_id, e.entry) > (?3, ?4)
ORDER BY k.output_id, e.entry LIMIT ?5`;

/** A mapping may point to an extracted slice while source-authored notes are attached to the
 * original native verse. Return notes on either selected span, scoped to that source. */
const MAPPED_ANNOTATIONS = `WITH selected AS (
  SELECT n.id, n.source_revision_id, n.segments_json FROM json_each(?2) requested
  CROSS JOIN native_spans n ON n.id = requested.value
  CROSS JOIN release_outputs ro ON ro.release_id = ?1 AND ro.output_id = n.output_id
), note_targets AS (
  SELECT id AS mapped_span_id, source_revision_id, id AS native_span_id FROM selected
  UNION
  SELECT m.id, m.source_revision_id, n.id FROM selected m
  CROSS JOIN json_each(m.segments_json) seg
  CROSS JOIN native_spans n INDEXED BY native_spans_verse_unit
    ON json_extract(n.segments_json, '$[0].unit_id') = json_extract(seg.value, '$.unit_id')
    AND n.kind = 'verse' AND n.source_revision_id = m.source_revision_id
  CROSS JOIN release_outputs ro ON ro.release_id = ?1 AND ro.output_id = n.output_id
  CROSS JOIN coverage c ON c.output_id = n.output_id AND c.source_revision_id = n.source_revision_id AND c.capability = 'source_context'
  WHERE n.id = n.output_id || '#' || json_extract(seg.value, '$.unit_id')
    AND EXISTS (SELECT 1 FROM json_each(c.native_extent_json, '$.unit_ids') u WHERE u.value = json_extract(seg.value, '$.unit_id'))
)
SELECT DISTINCT t.mapped_span_id, a.id, a.span_id, a.source_revision_id, a.kind, a.provider, a.basis_json, a.details_json
FROM note_targets t CROSS JOIN annotations a
  ON a.span_id = t.native_span_id AND a.source_revision_id = t.source_revision_id
CROSS JOIN release_outputs ro ON ro.release_id = ?1 AND ro.output_id = a.output_id
WHERE (t.mapped_span_id, a.id) > (?3, ?4)
ORDER BY t.mapped_span_id, a.id LIMIT ?5`;

/** Only an approved statement selected by this release; the approval reference stays private. */
const STATEMENT = `SELECT cs.id, cs.name, cs.version, cs.scripture_basis_json
FROM release_outputs ro
JOIN character_statements cs ON cs.output_id = ro.output_id
WHERE ro.release_id = ?1 AND cs.status = 'approved'
ORDER BY cs.id
LIMIT ?2`;

/** Search adapter only: index outputs for a capability in native order (their `order_range`
 *  start), with every artifact of each output. The unit list is not returned. An output without
 *  an order range sorts first and is reported as an incompatible index. */
const INDEX_FILES = `WITH idx AS (
  SELECT c.output_id, c.source_revision_id, c.capability, c.state, c.method_version, c.limitation, c.index_artifact_id,
    json_extract(c.native_extent_json, '$.order_range[0]') AS order_first,
    json_extract(c.native_extent_json, '$.order_range[1]') AS order_last
  FROM coverage c
  JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
  WHERE c.source_revision_id IN (SELECT value FROM json_each(?2)) AND c.capability = ?3)
SELECT idx.*, a.id AS artifact_id, a.sha256, a.byte_count, a.format, a.registered_locator
FROM idx LEFT JOIN artifacts a ON a.output_id = idx.output_id
LEFT JOIN index_routes routed ON routed.output_id = idx.output_id
WHERE (idx.source_revision_id, COALESCE(idx.order_first, -1), idx.output_id) >= (?5, ?6, ?7)
  AND (routed.output_id IS NULL OR idx.state != 'available'
    OR EXISTS (SELECT 1 FROM index_route_keys rk
      WHERE rk.search_key = ?4 AND rk.output_id = routed.output_id))
ORDER BY idx.source_revision_id, COALESCE(idx.order_first, -1), idx.output_id, a.id
LIMIT ?8`;

/** Distinguish a key absent in a selected index from a missing selected index. */
const INDEX_SOURCES = `SELECT c.source_revision_id
FROM coverage c JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
WHERE c.source_revision_id IN (SELECT value FROM json_each(?2)) AND c.capability = ?3
GROUP BY c.source_revision_id ORDER BY c.source_revision_id LIMIT ?4`;

/** The sources selected now, one row per source and capability, with their attribution. */
const RELEASE_SOURCES = `SELECT c.source_revision_id, c.capability, COUNT(*) AS outputs,
  SUM(c.state = 'available') AS available, s.name AS revision_name, w.name AS work_name, s.attribution
FROM coverage c
JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
JOIN source_nodes s ON s.id = c.source_revision_id
LEFT JOIN source_nodes r ON r.id = s.parent_id
LEFT JOIN source_nodes e ON e.id = r.parent_id
LEFT JOIN source_nodes w ON w.id = e.parent_id
WHERE (?2 IS NULL OR c.capability = ?2) AND (c.source_revision_id, c.capability) > (?3, ?4)
GROUP BY c.source_revision_id, c.capability
ORDER BY c.source_revision_id, c.capability
LIMIT ?5`;

/** Drive both passage lookups from the requested units and use the verse-unit index.
 *  The fixed join order keeps the planner from starting with every output in the release.
 *  Check coverage membership only for matching verse spans. */
const MATCHED_VERSES = `FROM json_each(?2) AS u
CROSS JOIN native_spans n INDEXED BY native_spans_verse_unit
  ON json_extract(n.segments_json, '$[0].unit_id') = u.value AND n.kind = 'verse'
CROSS JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
CROSS JOIN coverage c ON c.output_id = n.output_id AND c.source_revision_id = n.source_revision_id
  AND c.capability = 'source_context'`;

const COVERED_UNIT = `n.id = c.output_id || '#' || u.value
  AND (?3 IS NULL OR c.source_revision_id IN (SELECT value FROM json_each(?3)))
  AND EXISTS (SELECT 1 FROM json_each(c.native_extent_json, '$.unit_ids') AS covered WHERE covered.value = u.value)`;

/** Verse spans ordered by source and its linear order, resumable after an order.
 *  Look up body artifacts by ID before checking release membership. */
const UNIT_SPANS = `SELECT n.id, n.output_id, n.source_revision_id, n.parent_id, n.kind, n.label, n.native_order,
  n.coordinate_version, n.segments_json, n.basis_json, n.content_id, n.body_ranges_json, n.reading_kind,
  p.exact_text, s.name AS source_name, s.attribution AS source_attribution, g.start_order, u.value AS unit_id,
  (SELECT json_group_array(json_object('id', a.id, 'sha256', a.sha256, 'byte_count', a.byte_count,
      'format', a.format, 'registered_locator', a.registered_locator))
    FROM artifacts a CROSS JOIN release_outputs ra ON ra.output_id = a.output_id AND ra.release_id = ?1
    WHERE a.id IN (SELECT json_extract(b.value, '$.artifact_id') FROM json_each(n.body_ranges_json) AS b)) AS body_artifacts_json
${MATCHED_VERSES}
CROSS JOIN span_segments g ON g.span_id = n.id AND g.segment_ordinal = 0
CROSS JOIN source_nodes s ON s.id = n.source_revision_id
LEFT JOIN text_payloads p ON p.content_id = n.content_id
WHERE ${COVERED_UNIT}
  AND (n.source_revision_id, g.start_order) > (?4, ?5)
ORDER BY n.source_revision_id, g.start_order
LIMIT ?6`;

/** Which candidate units each selected source has as verses: one row per source. */
const UNIT_PRESENCE = `SELECT n.source_revision_id, group_concat(u.value, ',') AS units
${MATCHED_VERSES}
WHERE ${COVERED_UNIT}
GROUP BY n.source_revision_id
ORDER BY n.source_revision_id
LIMIT ?4`;

/** One page of explicit links and checked identity ranges. Both the mapping and its target
 * must be selected in the same release. The native candidate names are catalogue aliases;
 * identity is allowed only where a checked source-specific range explicitly permits it. */
const READER_MAPPINGS = `WITH requested AS (
  SELECT CAST(j.key AS INTEGER) AS position, json_extract(j.value, '$.ref') AS reader_ref,
    json_extract(j.value, '$.book') AS book, json_extract(j.value, '$.chapter') AS chapter,
    json_extract(j.value, '$.verse') AS verse, json_extract(j.value, '$.native_units') AS native_units
  FROM json_each(?2) j WHERE CAST(j.key AS INTEGER) >= ?5
), scope_sources AS (
  SELECT s.id AS source_revision_id FROM source_nodes s
  WHERE s.kind = 'source_revision' AND (?4 IS NULL OR s.id IN (SELECT value FROM json_each(?4)))
    AND EXISTS (SELECT 1 FROM coverage c INDEXED BY coverage_source
      CROSS JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
      WHERE c.source_revision_id = s.id AND c.capability = 'source_context')
), mappings AS (
  SELECT q.position, q.reader_ref, l.source_revision_id, l.role, l.ordinal, l.id AS mapping_id,
    l.status, l.basis_json, l.gap_reason,
    CASE WHEN EXISTS (SELECT 1 FROM native_spans n JOIN release_outputs nr
      ON nr.output_id = n.output_id AND nr.release_id = ?1
      WHERE n.id = l.span_id AND n.source_revision_id = l.source_revision_id)
      THEN l.span_id ELSE NULL END AS span_id,
    CASE WHEN l.role = 'superscription' THEN 0 ELSE 1 END AS role_order
  FROM scope_sources s CROSS JOIN requested q
  CROSS JOIN reader_reference_links l INDEXED BY sqlite_autoindex_reader_reference_links_2
    ON l.source_revision_id = s.source_revision_id AND l.reader_ref = q.reader_ref AND l.reader_scheme_version = ?3
  CROSS JOIN release_outputs ro ON ro.output_id = l.output_id AND ro.release_id = ?1
  UNION ALL
  SELECT q.position, q.reader_ref, b.source_revision_id, 'numbered_text', 0, b.id,
    'exact', b.basis_json, NULL, n.id, 1
  FROM scope_sources s CROSS JOIN requested q
  CROSS JOIN reader_reference_bases b INDEXED BY reader_reference_bases_lookup
    ON b.source_revision_id = s.source_revision_id AND b.reader_scheme_version = ?3
  CROSS JOIN release_outputs ro ON ro.output_id = b.output_id AND ro.release_id = ?1
  JOIN json_each(b.checked_extent_json, '$.ranges') rg
    ON json_extract(rg.value, '$.book_id') = q.book AND json_extract(rg.value, '$.chapter') = q.chapter
    AND q.verse BETWEEN json_extract(rg.value, '$.first_verse') AND json_extract(rg.value, '$.last_verse')
  JOIN json_each(q.native_units) nu
  CROSS JOIN native_spans n INDEXED BY native_spans_verse_unit
    ON json_extract(n.segments_json, '$[0].unit_id') = nu.value AND n.kind = 'verse' AND n.source_revision_id = b.source_revision_id
  JOIN release_outputs nr ON nr.output_id = n.output_id AND nr.release_id = ?1
  WHERE NOT EXISTS (SELECT 1 FROM reader_reference_links l JOIN release_outputs lr ON lr.output_id = l.output_id AND lr.release_id = ?1
      WHERE l.source_revision_id = b.source_revision_id AND l.reader_scheme_version = ?3 AND l.reader_ref = q.reader_ref AND l.role = 'numbered_text')
), all_mappings AS (
  SELECT * FROM mappings
  UNION ALL
  SELECT q.position, q.reader_ref, s.source_revision_id, 'numbered_text', 0, '',
    'uncovered', '{}', 'No checked mapping with selected native evidence is available', NULL, 1
  FROM requested q CROSS JOIN scope_sources s
  WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.position = q.position AND m.source_revision_id = s.source_revision_id AND m.role = 'numbered_text')
    AND NOT EXISTS (SELECT 1 FROM json_each(q.native_units) nu
      CROSS JOIN native_spans n INDEXED BY native_spans_verse_unit
        ON json_extract(n.segments_json, '$[0].unit_id') = nu.value AND n.kind = 'verse' AND n.source_revision_id = s.source_revision_id
      CROSS JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
      WHERE NOT EXISTS (SELECT 1 FROM reader_reference_links used INDEXED BY reader_reference_links_span
        JOIN release_outputs ur ON ur.output_id = used.output_id AND ur.release_id = ?1
        WHERE used.span_id = n.id AND used.source_revision_id = s.source_revision_id AND used.reader_scheme_version = ?3
          AND used.reader_ref IN (SELECT json_extract(value, '$.ref') FROM json_each(?2))))
  UNION ALL
  SELECT q.position, q.reader_ref, s.source_revision_id, 'numbered_text', 0, 'native-candidate',
    'native_candidate', '{}', NULL, n.id, 1
  FROM requested q CROSS JOIN scope_sources s
  JOIN json_each(q.native_units) nu
  CROSS JOIN native_spans n INDEXED BY native_spans_verse_unit
    ON json_extract(n.segments_json, '$[0].unit_id') = nu.value AND n.kind = 'verse' AND n.source_revision_id = s.source_revision_id
  CROSS JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
  WHERE NOT EXISTS (SELECT 1 FROM mappings m WHERE m.position = q.position AND m.source_revision_id = s.source_revision_id AND m.role = 'numbered_text')
    AND NOT EXISTS (SELECT 1 FROM reader_reference_links used INDEXED BY reader_reference_links_span
      JOIN release_outputs ur ON ur.output_id = used.output_id AND ur.release_id = ?1
      WHERE used.span_id = n.id AND used.source_revision_id = s.source_revision_id AND used.reader_scheme_version = ?3
        AND used.reader_ref IN (SELECT json_extract(value, '$.ref') FROM json_each(?2)))
)
SELECT * FROM all_mappings WHERE (position, source_revision_id, role_order, ordinal, mapping_id, COALESCE(span_id, '')) > (?5, ?6, ?7, ?8, ?9, ?10)
ORDER BY position, source_revision_id, role_order, ordinal, mapping_id, COALESCE(span_id, '') LIMIT ?11`;

/** Resolve overlapping units from the same checked targets; seek units independently of
 * reader-mapping pages so a unit spanning several pages is returned only once. */
const LITERARY_CONTEXTS =
  READER_MAPPINGS.slice(
    0,
    READER_MAPPINGS.indexOf('\nSELECT * FROM all_mappings WHERE'),
  ) +
  `
SELECT DISTINCT unit.source_revision_id, unit.id AS span_id
FROM all_mappings mapped
CROSS JOIN span_segments anchor INDEXED BY sqlite_autoindex_span_segments_1
  ON anchor.span_id = mapped.span_id AND anchor.source_revision_id = mapped.source_revision_id
CROSS JOIN span_segments overlap INDEXED BY span_segments_source_kind_order
  ON overlap.source_revision_id = anchor.source_revision_id AND overlap.kind = 'literary_unit'
  AND overlap.start_order <= anchor.end_order AND overlap.end_order >= anchor.start_order
CROSS JOIN native_spans unit ON unit.id = overlap.span_id AND unit.source_revision_id = overlap.source_revision_id
CROSS JOIN release_outputs ro ON ro.output_id = unit.output_id AND ro.release_id = ?1
WHERE mapped.status != 'native_candidate' AND ((unit.source_revision_id, unit.id) > (?11, ?12)
   OR (?13 = 1 AND unit.source_revision_id = ?11 AND unit.id = ?12))
ORDER BY unit.source_revision_id, unit.id LIMIT ?14`;

function readerParams(i: ReaderMappingInput): unknown[] {
  if (
    !Array.isArray(i.references) ||
    !i.references.length ||
    i.references.length > MAX_UNITS ||
    i.references.some(
      r =>
        !isIdentifier(r.ref) ||
        !isIdentifier(r.book) ||
        !isSafeCount(r.chapter) ||
        !isSafeCount(r.verse) ||
        !Array.isArray(r.native_units) ||
        !r.native_units.length ||
        r.native_units.length > 20 ||
        !r.native_units.every(x => isIdentifier(x)),
    )
  )
    throw new ReadError('invalid_request', 'Invalid reader references');
  return [
    JSON.stringify(i.references),
    id(i.scheme),
    i.sources == null ? null : JSON.stringify(list(i.sources)),
    ...(optionalAfter(i.after, 6) ?? [-1, '', -1, -1, '', '']),
  ];
}

const aidParams = (i: LanguageAidInput) => [
  id(i.key),
  ...(optionalAfter(i.after, 2) ?? ['', -1]),
];

export const QUERIES = {
  linked_aid_presence: {
    sql: `SELECT COALESCE(json_group_array(json(wanted.value)), '[]') AS keys
FROM json_each(?2) wanted WHERE EXISTS (
  SELECT 1 FROM aid_entry_rows e INDEXED BY aid_entries_lookup
  CROSS JOIN aid_output_keys k ON k.key = e.output_key
  CROSS JOIN release_outputs ro ON ro.output_id = k.output_id AND ro.release_id = ?1
  WHERE e.kind = json_extract(wanted.value, '$[0]')
    AND e.lookup_key = json_extract(wanted.value, '$[1]')
) LIMIT ?3`,
    params: (i: LinkedAidInput) => [
      JSON.stringify(i.keys.map(([kind, key]) => [id(kind), id(key)])),
    ],
  },
  proper_name: {
    sql: languageAidQuery('proper_name', 'lookup_key'),
    params: aidParams,
  },
  lexicon_strong: {
    sql: languageAidQuery('lexicon_entry', 'lookup_key'),
    params: aidParams,
  },
  lexicon_entry: {
    sql: languageAidQuery('lexicon_entry', 'entry_key'),
    params: aidParams,
  },
  grammar_expansion: {
    sql: languageAidQuery('grammar_expansion', 'lookup_key'),
    params: aidParams,
  },
  spans: {sql: SPANS, params: (i: SpansInput) => [JSON.stringify(list(i.ids))]},
  literary_overlap: {
    sql: OVERLAP,
    params: (i: OverlapInput) => {
      const start = order(i.start),
        end = order(i.end);
      if (end < start)
        throw new ReadError('invalid_request', 'Empty native order range');
      const after = optionalAfter(i.after, 3) ?? [-1, '', -1];
      return [
        id(i.source_revision_id),
        JSON.stringify(list(i.kinds, 8)),
        start,
        end,
        ...after,
      ];
    },
  },
  annotations: {
    sql: ANNOTATIONS,
    params: (i: AnnotationsInput) => [
      JSON.stringify(list(i.span_ids)),
      ...(optionalAfter(i.after, 2) ?? ['', '']),
    ],
  },
  mapped_annotations: {
    sql: MAPPED_ANNOTATIONS,
    params: (i: AnnotationsInput) => [
      JSON.stringify(list(i.span_ids)),
      ...(optionalAfter(i.after, 2) ?? ['', '']),
    ],
  },
  statement: {sql: STATEMENT, params: (_: StatementInput) => []},
  release_sources: {
    sql: RELEASE_SOURCES,
    params: (i: ReleaseSourcesInput) => [
      i.capability == null ? null : id(i.capability),
      ...(optionalAfter(i.after, 2) ?? ['', '']),
    ],
  },
  unit_presence: {
    sql: UNIT_PRESENCE,
    params: (i: UnitPresenceInput) => [
      JSON.stringify(list(i.units, MAX_UNITS)),
      i.sources == null ? null : JSON.stringify(list(i.sources)),
    ],
  },
  unit_spans: {
    sql: UNIT_SPANS,
    params: (i: UnitSpansInput) => [
      JSON.stringify(list(i.units, MAX_UNITS)),
      i.sources == null ? null : JSON.stringify(list(i.sources)),
      ...(optionalAfter(i.after, 2) ?? ['', -1]),
    ],
  },
  reader_mappings: {sql: READER_MAPPINGS, params: readerParams},
  literary_contexts: {
    sql: LITERARY_CONTEXTS,
    params: (i: LiteraryContextInput) => [
      ...readerParams({...i, after: null}),
      ...(optionalAfter(i.after, 2) ?? ['', '']),
      i.include_current ? 1 : 0,
    ],
  },
  index_files: {
    sql: INDEX_FILES,
    params: (i: IndexFilesInput) => [
      JSON.stringify(list(i.source_revision_ids)),
      id(i.capability),
      key(i.key),
      ...(optionalAfter(i.after, 3) ?? ['', -1, '']),
    ],
  },
  index_sources: {
    sql: INDEX_SOURCES,
    params: (i: IndexSourcesInput) => [
      JSON.stringify(list(i.source_revision_ids)),
      id(i.capability),
    ],
  },
} satisfies Record<string, Declaration<never>>;

export type QueryName = keyof typeof QUERIES;
export type QueryInput<N extends QueryName> = Parameters<
  (typeof QUERIES)[N]['params']
>[0];

export function isQueryName(name: unknown): name is QueryName {
  return typeof name === 'string' && Object.hasOwn(QUERIES, name);
}
