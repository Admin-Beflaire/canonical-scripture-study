import { isIdentifier, sha256Hex } from './bytes.ts';
import { artifactFrom, readArtifact, type RegisteredArtifact } from './objects.ts';
import { RELATIONSHIPS_PER_QUERY } from './queries.ts';
import type { ReadSession } from './session.ts';
import { ReadError, limitation, type Limitation } from './states.ts';

export interface NativeSegment { unit_id: string; start: number; end: number }

/** Exact selected wording for one native span, with its attribution and coordinates.
 *  `text` is null only for a recorded gap. No object key or internal output ID is included. */
export interface SpanEvidence {
  span_id: string; source_revision_id: string; source_name: string; attribution: string;
  kind: string; label: string; native_order: number; coordinate_version: string;
  segments: NativeSegment[]; basis: Record<string, unknown>; reading_kind: string;
  text: string[] | null;
}

export interface SpanRead { spans: SpanEvidence[]; limitations: Limitation[]; remaining: string[] }

function json<T>(value: unknown, check: (v: unknown) => boolean): T {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : undefined; } catch { parsed = undefined; }
  if (!check(parsed)) throw new ReadError('corrupt', 'Inconsistent evidence record');
  return parsed as T;
}
const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
const isSegments = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(s => isObject(s) && isIdentifier(s.unit_id)
  && Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.start >= 0 && s.end >= s.start);
interface BodyRange { segment_ordinal: number; artifact_id: string; byte_offset: number; byte_length: number; sha256: string }

/** Resolves span IDs to exact wording in the current release. Missing, corrupt and
 *  not-yet-read spans are reported separately; valid spans are returned regardless. */
export async function readSpans(session: ReadSession, ids: string[]): Promise<SpanRead> {
  const out: SpanRead = { spans: [], limitations: [], remaining: [] };
  if (!session.canQuery()) return { ...out, remaining: [...ids] };
  const { rows } = await session.query('spans', { ids });
  const found = new Map(rows.map(row => [row.id as string, row]));
  for (const id of ids) {
    const row = found.get(id);
    if (!row) { out.limitations.push(limitation('missing_evidence', id, 'Not available in the current release')); continue; }
    try {
      const segments = json<NativeSegment[]>(row.segments_json, isSegments);
      const evidence: SpanEvidence = {
        span_id: id, source_revision_id: String(row.source_revision_id), source_name: String(row.source_name),
        attribution: String(row.source_attribution), kind: String(row.kind), label: String(row.label),
        native_order: Number(row.native_order), coordinate_version: String(row.coordinate_version), segments,
        basis: json(row.basis_json, isObject), reading_kind: String(row.reading_kind), text: null,
      };
      if (row.content_id !== null) {
        if (typeof row.exact_text !== 'string' || await sha256Hex(row.exact_text) !== row.content_id)
          throw new ReadError('corrupt', 'Text payload does not match its digest');
        evidence.text = [row.exact_text];
      } else if (row.reading_kind !== 'gap') {
        const text = await bodyText(session, row, segments.length);
        if (text === null) { out.remaining.push(id); continue; }
        evidence.text = text;
      }
      out.spans.push(evidence);
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      if (error.state === 'budget') { out.remaining.push(id); continue; }
      out.limitations.push(limitation(error.state, id, error.message));
    }
  }
  return out;
}

/** Ordered R2 body ranges for an extracted span. Returns null if the allowance cannot
 *  cover every range, so a span is never returned with part of its wording. */
async function bodyText(session: ReadSession, row: Record<string, unknown>, segmentCount: number): Promise<string[] | null> {
  const ranges = json<BodyRange[]>(row.body_ranges_json, v => Array.isArray(v) && v.length === segmentCount);
  const artifacts = new Map<string, RegisteredArtifact>();
  for (const item of json<Record<string, unknown>[]>(row.body_artifacts_json ?? '[]', Array.isArray)) {
    const artifact = artifactFrom(item);
    artifacts.set(artifact.id, artifact);
  }
  ranges.forEach((range, i) => {
    if (!isObject(range) || range.segment_ordinal !== i) throw new ReadError('corrupt', 'Body ranges out of native segment order');
  });
  const total = ranges.reduce((n, r) => n + r.byte_length, 0);
  if (session.budget.usage().r2Reads + ranges.length > session.budget.limits.r2Reads
      || session.budget.usage().r2Bytes + total > session.budget.limits.r2Bytes) {
    if (ranges.some(r => r.byte_length > session.budget.limits.pageBytes)) throw new ReadError('exceeds_limits', 'A body range exceeds the configured cap');
    return null;
  }
  const text: string[] = [];
  for (const range of ranges) {
    const artifact = artifacts.get(range.artifact_id);
    if (!artifact) throw new ReadError('missing_evidence', 'Body artifact is not selected in the current release');
    text.push(await readArtifact(session, artifact, { offset: range.byte_offset, length: range.byte_length, sha256: range.sha256 }));
  }
  return text;
}

export interface RelationshipMember {
  role: string; ordinal: number; correspondence: string; gap_reason: string | null;
  /** `selected`: the endpoint span is in the current release; `unavailable`: it exists but is
   *  not selected now (never filled from another release); `none`: a recorded gap. */
  endpoint: { state: 'selected'; span_id: string; source_revision_id: string; label: string; native_order: number; coordinate_version: string }
    | { state: 'unavailable'; span_id: string } | { state: 'none' };
}
export interface RelationshipEvidence { id: string; kind: string; direction: string; status: string; basis: Record<string, unknown>; members: RelationshipMember[] }

/** Typed, directed, ordered relationships touching one span, one bounded page at a time.
 *  `after` continues from the last complete relationship. */
export async function readRelationships(session: ReadSession, spanId: string, kinds: string[] | null = null, after: string | null = null):
    Promise<{ relationships: RelationshipEvidence[]; more: boolean; after: string | null }> {
  const { rows, more: truncated } = await session.query('relationships', { span_id: spanId, kinds, after: after === null ? null : [after] });
  const groups: RelationshipEvidence[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.id !== row.relationship_id) {
      group = { id: String(row.relationship_id), kind: String(row.kind), direction: String(row.direction), status: String(row.status),
        basis: json(row.basis_json, isObject), members: [] };
      groups.push(group);
    }
    group.members.push({ role: String(row.role), ordinal: Number(row.ordinal), correspondence: String(row.correspondence),
      gap_reason: typeof row.gap_reason === 'string' ? row.gap_reason : null,
      endpoint: row.span_id === null ? { state: 'none' } : row.endpoint_selected === 1
        ? { state: 'selected', span_id: String(row.span_id), source_revision_id: String(row.endpoint_source_revision_id), label: String(row.endpoint_label),
            native_order: Number(row.endpoint_native_order), coordinate_version: String(row.endpoint_coordinate_version) }
        : { state: 'unavailable', span_id: String(row.span_id) } });
  }
  // The inner statement fetches one extra relationship and the outer one may cut members:
  // drop the last group whenever more may follow, so no relationship is returned partially.
  let more = false;
  if (groups.length > RELATIONSHIPS_PER_QUERY || truncated) { groups.pop(); more = true; }
  if (more && groups.length === 0) throw new ReadError('exceeds_limits', 'One relationship has more members than a query may return');
  return { relationships: groups, more, after: more ? groups.at(-1)!.id : null };
}
