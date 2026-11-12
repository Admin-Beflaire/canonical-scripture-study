import { compareUtf8, isIdentifier, isSafeCount, sha256Hex } from '../read/bytes.ts';
import type { NativeSegment, SpanEvidence } from '../read/evidence.ts';
import { artifactFrom, readSlices, type RegisteredArtifact } from '../read/objects.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError, limitation, type Limitation } from '../read/states.ts';
import { assembleBatch, ENVELOPE_RESERVE, type Batch, type EvidenceItem, type PassageAnnotation } from '../results/batch.ts';
import { encodeContinuation, resumeContinuation, type PositionCheck } from '../results/continuation.ts';
import { candidateUnits, contextUnits, parseReference, type PassageRequest } from '../scope/references.ts';

/** The passage part of a Study workload: references in each source's own numbering, the
 *  sources to read (all selected sources when null) and whether to add the surrounding chapter. */
export interface PassageWorkload { mode: string; depth: string; language: string; references: string[]; sources: string[] | null; context: boolean }

export const MAX_REFERENCES = 4;

/** Position: the reference being read and the last delivered verse (source, linear order). */
interface PassagePosition { ref: number; source: string; order: number }

export function normalizePassageWorkload(w: PassageWorkload): PassageWorkload {
  if (!Array.isArray(w.references) || w.references.length < 1 || w.references.length > MAX_REFERENCES)
    throw new ReadError('invalid_request', `Give 1 to ${MAX_REFERENCES} references`);
  for (const ref of w.references) parseReference(ref);
  let sources: string[] | null = null;
  if (w.sources != null) {
    if (!Array.isArray(w.sources) || w.sources.length < 1 || w.sources.length > 20 || !w.sources.every(s => isIdentifier(s)))
      throw new ReadError('invalid_request', 'Sources are source revision IDs as listed by the study tool');
    sources = [...new Set(w.sources)].sort(compareUtf8);
  }
  return { mode: w.mode, depth: w.depth, language: w.language, references: w.references.map(r => r.trim()), sources, context: w.context === true };
}

export const PASSAGE_CHECKS: Readonly<Record<string, PositionCheck>> = Object.freeze({
  passage(pos: unknown, key: unknown, workload: unknown) {
    const w = workload as PassageWorkload;
    if (key !== null || !pos || typeof pos !== 'object' || Array.isArray(pos)) return false;
    const p = pos as Record<string, unknown>;
    if (JSON.stringify(Object.keys(p).sort()) !== '["order","ref","source"]') return false;
    return Number.isSafeInteger(p.ref) && (p.ref as number) >= 0 && (p.ref as number) < w.references.length
      && (p.source === '' || isIdentifier(p.source)) && (p.order === -1 || isSafeCount(p.order));
  },
});

interface BodyRange { segment_ordinal: number; artifact_id: string; byte_offset: number; byte_length: number; sha256: string }
interface Row { evidence: SpanEvidence; order: number; ranges: BodyRange[]; artifacts: Map<string, RegisteredArtifact>; textFromD1: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function parsed(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) : undefined; } catch { return undefined; } }

async function toRow(r: Record<string, unknown>): Promise<Row> {
  const segments = parsed(r.segments_json);
  const basis = parsed(r.basis_json);
  if (!Array.isArray(segments) || !segments.length || !segments.every(s => isObject(s) && isIdentifier(s.unit_id) && isSafeCount(s.start) && isSafeCount(s.end))
      || !isObject(basis) || !isSafeCount(r.start_order))
    throw new ReadError('corrupt', 'Inconsistent verse record');
  const evidence: SpanEvidence = {
    span_id: String(r.id), source_revision_id: String(r.source_revision_id), source_name: String(r.source_name),
    attribution: String(r.source_attribution), kind: String(r.kind), label: String(r.label), native_order: Number(r.native_order),
    coordinate_version: String(r.coordinate_version), segments: segments as NativeSegment[], basis, reading_kind: String(r.reading_kind), text: null,
  };
  const row: Row = { evidence, order: r.start_order as number, ranges: [], artifacts: new Map(), textFromD1: false };
  if (r.content_id !== null && r.content_id !== undefined) {
    if (typeof r.exact_text !== 'string' || await sha256Hex(r.exact_text) !== r.content_id)
      throw new ReadError('corrupt', 'Text payload does not match its digest');
    evidence.text = [r.exact_text];
    row.textFromD1 = true;
  } else if (evidence.reading_kind !== 'gap') {
    const ranges = parsed(r.body_ranges_json);
    if (!Array.isArray(ranges) || ranges.length !== segments.length || ranges.some((x, i) => !isObject(x) || x.segment_ordinal !== i))
      throw new ReadError('corrupt', 'Body ranges out of native segment order');
    row.ranges = ranges as BodyRange[];
    for (const item of (parsed(r.body_artifacts_json ?? '[]') as Record<string, unknown>[] | undefined) ?? []) {
      const artifact = artifactFrom(item);
      row.artifacts.set(artifact.id, artifact);
    }
  }
  return row;
}

/** Reads the R2 wording of many verses with few reads: neighbouring ranges of one artifact are
 *  read together (within the page cap) and each verse is checked against its own digest.
 *  Verses the allowance cannot cover stay without text and are reported as remaining. */
async function fillBodies(session: ReadSession, rows: Row[], limitations: Limitation[]): Promise<Set<Row>> {
  const pending = new Set<Row>();
  type Piece = { row: Row; index: number; range: BodyRange; artifact: RegisteredArtifact };
  const pieces: Piece[] = [];
  for (const row of rows) row.ranges.forEach((range, index) => {
    const artifact = row.artifacts.get(range.artifact_id);
    if (!artifact) throw new ReadError('missing_evidence', 'Body artifact is not selected in the current release');
    pieces.push({ row, index, range, artifact });
  });
  pieces.sort((a, b) => compareUtf8(a.artifact.id, b.artifact.id) || a.range.byte_offset - b.range.byte_offset);
  const cap = session.budget.limits.pageBytes;
  const groups: Piece[][] = [];
  for (const piece of pieces) {
    const group = groups.at(-1);
    const start = group?.[0].range.byte_offset ?? 0;
    const end = piece.range.byte_offset + piece.range.byte_length;
    if (group && group[0].artifact.id === piece.artifact.id && end - start <= cap
        && piece.range.byte_offset - (group.at(-1)!.range.byte_offset + group.at(-1)!.range.byte_length) <= 256) group.push(piece);
    else groups.push([piece]);
  }
  const texts = new Map<Row, (string | null)[]>();
  for (const group of groups) {
    const start = group[0].range.byte_offset;
    const end = Math.max(...group.map(p => p.range.byte_offset + p.range.byte_length));
    let read: (string | null)[];
    try { read = await readSlices(session, group[0].artifact, start, end - start, group.map(p => ({ offset: p.range.byte_offset, length: p.range.byte_length, sha256: p.range.sha256 }))); }
    catch (error) {
      if (error instanceof ReadError && error.state === 'budget') { for (const p of group) pending.add(p.row); continue; }
      throw error;
    }
    group.forEach((p, i) => {
      const list = texts.get(p.row) ?? new Array(p.row.ranges.length).fill(undefined);
      list[p.index] = read[i];
      texts.set(p.row, list);
    });
  }
  for (const row of rows) {
    if (!row.ranges.length || pending.has(row)) continue;
    const list = texts.get(row) ?? [];
    if (list.some(t => t === null || t === undefined)) {
      limitations.push(limitation('corrupt', row.evidence.label, 'Stored wording failed its check and is withheld'));
      row.evidence.text = null;
      row.ranges = [];
      continue;
    }
    row.evidence.text = list as string[];
  }
  return pending;
}

async function annotationsFor(session: ReadSession, rows: Row[]): Promise<Map<string, PassageAnnotation[]> | null> {
  const ids = rows.map(r => r.evidence.span_id);
  const out = new Map<string, PassageAnnotation[]>();
  for (let i = 0; i < ids.length; i += 20) {
    if (!session.canQuery()) return null;
    const chunk = ids.slice(i, i + 20);
    let after: [string, string] | null = null;
    for (;;) {
      if (!session.canQuery()) return null;
      const { rows: found, more }: { rows: Record<string, unknown>[]; more: boolean } = await session.query('annotations', { span_ids: chunk, after });
      for (const a of found) {
        const details = parsed(a.details_json);
        const list = out.get(String(a.span_id)) ?? [];
        list.push({ kind: String(a.kind), provider: String(a.provider), details: isObject(details) ? details : {} });
        out.set(String(a.span_id), list);
      }
      if (!more || !found.length) break;
      after = [String(found.at(-1)!.span_id), String(found.at(-1)!.id)];
    }
  }
  return out;
}

/** One bounded batch of passage evidence: the requested verses, and (with context) the rest of
 *  their chapters, in each source's native order. Continues across batches without narrowing. */
export async function passageBatch(session: ReadSession, workload: PassageWorkload, continuation: string | null, guidanceVersion: string): Promise<Batch> {
  const w = normalizePassageWorkload(workload);
  const refs: PassageRequest[] = w.references.map(parseReference);
  let pos: PassagePosition = { ref: 0, source: '', order: -1 };
  if (continuation !== null) pos = (await resumeContinuation(continuation, w, PASSAGE_CHECKS)).pos as PassagePosition;
  session.budget.spendResult(ENVELOPE_RESERVE);
  const limitations: Limitation[] = [];
  const items: { item: EvidenceItem; ref: number; source: string; order: number }[] = [];
  let next: PassagePosition | null = pos;
  // Read references in order while the request allowance lasts.
  while (next) {
    if (!session.canQuery()) break;
    if (items.length && session.budget.usage().r2Reads >= session.budget.limits.r2Reads) break;
    const ref: PassageRequest = refs[next.ref];
    const requested = new Set(candidateUnits(ref));
    const units: string[] = w.context ? contextUnits(ref) : [...requested];
    const { rows: found, more }: { rows: Record<string, unknown>[]; more: boolean } = await session.query('unit_spans', { units, sources: w.sources, after: [next.source, next.order] });
    if (!found.length && next.source === '') limitations.push(limitation('missing_evidence', ref.text,
      w.sources ? 'None of the named sources has this reference in the current release' : 'No selected source has this reference in the current release'));
    const rows: Row[] = [];
    for (const r of found) {
      try { rows.push(await toRow(r)); }
      catch (error) { if (error instanceof ReadError) limitations.push(limitation(error.state, String(r.label ?? r.id), error.message)); else throw error; }
    }
    const pending = await fillBodies(session, rows, limitations);
    // A verse is never delivered after one whose wording is still unread: stop at the first pending verse.
    const firstPending = rows.findIndex(r => pending.has(r));
    const deliverable = firstPending < 0 ? rows : rows.slice(0, firstPending);
    const notes = deliverable.length ? await annotationsFor(session, deliverable) : new Map<string, PassageAnnotation[]>();
    if (notes === null) limitations.push(limitation('budget', 'annotations', 'Textual notes for these verses were not read in this batch'));
    for (const row of deliverable) {
      const item: EvidenceItem = { kind: 'source_text', span: row.evidence,
        role: requested.has(row.evidence.segments[0].unit_id) ? 'requested' : 'context',
        ...(notes ? { annotations: notes.get(row.evidence.span_id) ?? [] } : {}) };
      items.push({ item, ref: next.ref, source: row.evidence.source_revision_id, order: row.order });
    }
    const last = deliverable.at(-1);
    if (firstPending >= 0) { next = last ? { ref: next.ref, source: last.evidence.source_revision_id, order: last.order } : next; break; }
    if (more) {
      // Resume after the last row of this page (a withheld record is reported, not re-read).
      const tail: Record<string, unknown> = found.at(-1)!;
      next = { ref: next.ref, source: String(tail.source_revision_id), order: Number(tail.start_order) };
      continue;
    }
    next = next.ref + 1 < refs.length ? { ref: next.ref + 1, source: '', order: -1 } : null;
  }
  const { batch, deferred } = assembleBatch({
    release_id: session.release.id, mode: w.mode, depth: w.depth,
    delivered_scope: { references: w.references, sources: w.sources ?? 'all selected' },
    context_scope: w.context ? { chapters: refs.map(r => `${r.book} ${r.from.chapter}${r.to.chapter !== r.from.chapter ? `-${r.to.chapter}` : ''}`),
      note: 'No literary-unit boundaries are recorded for these sources yet; the context is the whole chapter.' } : null,
    evidence: items.map(x => x.item), citations: [], searched_scope: [], coverage: [], limitations,
    remaining: null, continuation: null, guidance_version: guidanceVersion,
  }, session.budget);
  // Resume after the last verse actually delivered.
  const delivered = items.slice(0, items.length - deferred.length);
  let resume: PassagePosition | null = next;
  if (deferred.length) {
    const last = delivered.at(-1);
    resume = last ? { ref: last.ref, source: last.source, order: last.order } : pos;
  }
  if (resume && delivered.length === 0 && resume.ref === pos.ref && resume.source === pos.source && resume.order === pos.order)
    throw new ReadError('exceeds_limits', 'Not one verse of this passage fits a batch');
  batch.continuation = resume ? await encodeContinuation(w, { op: 'passage', pos: resume, key: null }) : null;
  batch.remaining = resume ? { passage: 'continues', reference: w.references[resume.ref] } : null;
  return batch;
}
