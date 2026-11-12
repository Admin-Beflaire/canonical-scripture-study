import { isIdentifier, isSafeCount } from './bytes.ts';
import { ReadError } from './states.ts';

/** The only D1 statements Study runs. Every statement is a fixed SELECT whose first
 *  parameter is the current release ID and which reaches evidence rows only through
 *  `release_outputs` membership. Hosts never supply SQL, table names or object keys.
 *  The final parameter is always the row limit (one more than returned, to detect more). */
interface Declaration<I> { sql: string; params(input: I): unknown[] }

const MAX_LIST = 20;
/** Candidate verse units for one passage read: three chapters of candidates. */
export const MAX_UNITS = 540;
/** The relationship query limits relationships in its inner statement and rows in the outer one. */
export const RELATIONSHIPS_PER_QUERY = 10;
const list = (value: unknown, max = MAX_LIST): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || !value.every(v => isIdentifier(v)) || new Set(value).size !== value.length)
    throw new ReadError('invalid_request', 'Expected a short list of distinct identifiers');
  return value as string[];
};
const id = (value: unknown): string => {
  if (!isIdentifier(value)) throw new ReadError('invalid_request', 'Expected an identifier');
  return value;
};
const optionalAfter = (value: unknown, size: number): unknown[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== size || !value.every(v => v === '' || v === -1 || isIdentifier(v, 1024) || isSafeCount(v)))
    throw new ReadError('invalid_request', 'Invalid query position');
  return value;
};
const order = (value: unknown): number => {
  if (!isSafeCount(value)) throw new ReadError('invalid_request', 'Expected a native order');
  return value;
};

export interface SpansInput { ids: string[] }
export interface OverlapInput { source_revision_id: string; kinds: string[]; start: number; end: number; after?: [number, string, number] | null }
export interface AnnotationsInput { span_ids: string[]; after?: [string, string] | null }
export interface RelationshipsInput { span_id: string; kinds?: string[] | null; after?: [string] | null }
export interface CountsInput { span_id: string }
export interface CoverageInput { source_revision_ids: string[]; after?: [string, string, string] | null }
export interface PackagesInput { subject: string; after?: [string] | null }
export interface StatementInput { [key: string]: never }
export interface ReleaseSourcesInput { after?: [string, string] | null }
export interface UnitSpansInput { units: string[]; sources?: string[] | null; after?: [string, number] | null }
export interface IndexFilesInput { source_revision_ids: string[]; capability: string; after?: [string, number, string] | null }

const SPANS = `SELECT n.id, n.output_id, n.source_revision_id, n.parent_id, n.kind, n.label, n.native_order,
  n.coordinate_version, n.segments_json, n.basis_json, n.content_id, n.body_ranges_json, n.reading_kind,
  p.exact_text, s.name AS source_name, s.attribution AS source_attribution,
  (SELECT json_group_array(json_object('id', a.id, 'sha256', a.sha256, 'byte_count', a.byte_count,
      'format', a.format, 'registered_locator', a.registered_locator))
    FROM artifacts a JOIN release_outputs ra ON ra.output_id = a.output_id AND ra.release_id = ?1
    WHERE a.id IN (SELECT json_extract(b.value, '$.artifact_id') FROM json_each(n.body_ranges_json) AS b)) AS body_artifacts_json
FROM native_spans n
JOIN release_outputs ro ON ro.output_id = n.output_id AND ro.release_id = ?1
JOIN source_nodes s ON s.id = n.source_revision_id
LEFT JOIN text_payloads p ON p.content_id = n.content_id
WHERE n.id IN (SELECT value FROM json_each(?2))
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

/** Endpoints are returned only when their own span belongs to the current release;
 *  an unselected endpoint is reported, never filled from another release. */
const RELATIONSHIPS = `WITH matched AS (
  SELECT DISTINCT r.id FROM relation_members m
  JOIN relationships r ON r.id = m.relationship_id
  JOIN release_outputs ro ON ro.output_id = r.output_id AND ro.release_id = ?1
  WHERE m.span_id = ?2 AND (?3 IS NULL OR r.kind IN (SELECT value FROM json_each(?3))) AND r.id > ?4
  ORDER BY r.id LIMIT ?5)
SELECT r.id AS relationship_id, r.kind, r.direction, r.status, r.basis_json,
  m.role, m.ordinal, m.span_id, m.correspondence, m.gap_reason,
  CASE WHEN m.span_id IS NULL THEN NULL WHEN es.id IS NULL THEN 0 ELSE 1 END AS endpoint_selected,
  es.source_revision_id AS endpoint_source_revision_id, es.label AS endpoint_label,
  es.native_order AS endpoint_native_order, es.coordinate_version AS endpoint_coordinate_version
FROM matched x
JOIN relationships r ON r.id = x.id
JOIN relation_members m ON m.relationship_id = r.id
LEFT JOIN native_spans es ON es.id = m.span_id
  AND EXISTS (SELECT 1 FROM release_outputs eo WHERE eo.output_id = es.output_id AND eo.release_id = ?1)
ORDER BY r.id, m.role, m.ordinal
LIMIT ?6`;

const COUNTS = `SELECT r.kind, COUNT(DISTINCT r.id) AS count
FROM relation_members m
JOIN relationships r ON r.id = m.relationship_id
JOIN release_outputs ro ON ro.output_id = r.output_id AND ro.release_id = ?1
WHERE m.span_id = ?2
GROUP BY r.kind ORDER BY r.kind
LIMIT ?3`;

const COVERAGE = `SELECT c.output_id, c.source_revision_id, c.native_extent_json, c.capability, c.state,
  c.method_version, c.index_artifact_id, c.limitation
FROM coverage c
JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
WHERE c.source_revision_id IN (SELECT value FROM json_each(?2))
  AND (c.source_revision_id, c.capability, c.output_id) > (?3, ?4, ?5)
ORDER BY c.source_revision_id, c.capability, c.output_id
LIMIT ?6`;

const PACKAGES = `SELECT p.id, p.subject, p.source_refs_json
FROM release_outputs ro
JOIN study_packages p ON p.output_id = ro.output_id
WHERE ro.release_id = ?1 AND p.subject = ?2 AND p.id > ?3
ORDER BY p.id
LIMIT ?4`;

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
WHERE (idx.source_revision_id, COALESCE(idx.order_first, -1), idx.output_id) >= (?4, ?5, ?6)
ORDER BY idx.source_revision_id, COALESCE(idx.order_first, -1), idx.output_id, a.id
LIMIT ?7`;

/** The sources selected now, one row per source and capability, with their attribution. */
const RELEASE_SOURCES = `SELECT c.source_revision_id, c.capability, COUNT(*) AS outputs,
  SUM(c.state = 'available') AS available, s.name AS revision_name, w.name AS work_name, s.attribution
FROM coverage c
JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
JOIN source_nodes s ON s.id = c.source_revision_id
LEFT JOIN source_nodes r ON r.id = s.parent_id
LEFT JOIN source_nodes e ON e.id = r.parent_id
LEFT JOIN source_nodes w ON w.id = e.parent_id
WHERE (c.source_revision_id, c.capability) > (?2, ?3)
GROUP BY c.source_revision_id, c.capability
ORDER BY c.source_revision_id, c.capability
LIMIT ?4`;

/** Verse spans for candidate native unit IDs, from the selected source-context outputs whose
 *  extent lists the unit. A verse span's ID is its output ID and unit ID (`output#unit`), as
 *  Preparation records it; the first segment must also name that unit. Ordered by the source's
 *  linear order (first segment start), resumable after an order. Unknown candidates match nothing. */
const UNIT_SPANS = `SELECT n.id, n.output_id, n.source_revision_id, n.parent_id, n.kind, n.label, n.native_order,
  n.coordinate_version, n.segments_json, n.basis_json, n.content_id, n.body_ranges_json, n.reading_kind,
  p.exact_text, s.name AS source_name, s.attribution AS source_attribution, g.start_order,
  (SELECT json_group_array(json_object('id', a.id, 'sha256', a.sha256, 'byte_count', a.byte_count,
      'format', a.format, 'registered_locator', a.registered_locator))
    FROM artifacts a JOIN release_outputs ra ON ra.output_id = a.output_id AND ra.release_id = ?1
    WHERE a.id IN (SELECT json_extract(b.value, '$.artifact_id') FROM json_each(n.body_ranges_json) AS b)) AS body_artifacts_json
FROM coverage c
JOIN release_outputs ro ON ro.output_id = c.output_id AND ro.release_id = ?1
JOIN json_each(c.native_extent_json, '$.unit_ids') AS u ON u.value IN (SELECT value FROM json_each(?2))
JOIN native_spans n ON n.id = c.output_id || '#' || u.value
JOIN span_segments g ON g.span_id = n.id AND g.segment_ordinal = 0
JOIN source_nodes s ON s.id = n.source_revision_id
LEFT JOIN text_payloads p ON p.content_id = n.content_id
WHERE c.capability = 'source_context' AND n.kind = 'verse'
  AND json_extract(n.segments_json, '$[0].unit_id') = u.value
  AND (?3 IS NULL OR c.source_revision_id IN (SELECT value FROM json_each(?3)))
  AND (n.source_revision_id, g.start_order) > (?4, ?5)
ORDER BY n.source_revision_id, g.start_order
LIMIT ?6`;

export const QUERIES = {
  spans: { sql: SPANS, params: (i: SpansInput) => [JSON.stringify(list(i.ids))] },
  literary_overlap: { sql: OVERLAP, params: (i: OverlapInput) => {
    const start = order(i.start), end = order(i.end);
    if (end < start) throw new ReadError('invalid_request', 'Empty native order range');
    const after = optionalAfter(i.after, 3) ?? [-1, '', -1];
    return [id(i.source_revision_id), JSON.stringify(list(i.kinds, 8)), start, end, ...after];
  } },
  annotations: { sql: ANNOTATIONS, params: (i: AnnotationsInput) =>
    [JSON.stringify(list(i.span_ids)), ...(optionalAfter(i.after, 2) ?? ['', ''])] },
  relationships: { sql: RELATIONSHIPS, params: (i: RelationshipsInput) =>
    [id(i.span_id), i.kinds == null ? null : JSON.stringify(list(i.kinds, 8)), ...(optionalAfter(i.after, 1) ?? ['']),
      RELATIONSHIPS_PER_QUERY + 1] },
  relationship_counts: { sql: COUNTS, params: (i: CountsInput) => [id(i.span_id)] },
  coverage: { sql: COVERAGE, params: (i: CoverageInput) =>
    [JSON.stringify(list(i.source_revision_ids)), ...(optionalAfter(i.after, 3) ?? ['', '', ''])] },
  packages: { sql: PACKAGES, params: (i: PackagesInput) => [id(i.subject), ...(optionalAfter(i.after, 1) ?? [''])] },
  statement: { sql: STATEMENT, params: (_: StatementInput) => [] },
  release_sources: { sql: RELEASE_SOURCES, params: (i: ReleaseSourcesInput) => [...(optionalAfter(i.after, 2) ?? ['', ''])] },
  unit_spans: { sql: UNIT_SPANS, params: (i: UnitSpansInput) =>
    [JSON.stringify(list(i.units, MAX_UNITS)), i.sources == null ? null : JSON.stringify(list(i.sources)), ...(optionalAfter(i.after, 2) ?? ['', -1])] },
  index_files: { sql: INDEX_FILES, params: (i: IndexFilesInput) =>
    [JSON.stringify(list(i.source_revision_ids)), id(i.capability), ...(optionalAfter(i.after, 3) ?? ['', -1, ''])] },
} satisfies Record<string, Declaration<never>>;

export type QueryName = keyof typeof QUERIES;
export type QueryInput<N extends QueryName> = Parameters<(typeof QUERIES)[N]['params']>[0];


export function isQueryName(name: unknown): name is QueryName {
  return typeof name === 'string' && Object.hasOwn(QUERIES, name);
}
