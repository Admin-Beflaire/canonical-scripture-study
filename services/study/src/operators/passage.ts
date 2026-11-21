import { compareUtf8, isIdentifier, isSafeCount, sha256Hex, utf8Length } from '../read/bytes.ts';
import type { NativeSegment, SpanEvidence } from '../read/evidence.ts';
import { artifactFrom, readVerifiedRange, readSlices, type RegisteredArtifact } from '../read/objects.ts';
import type { ReadSession } from '../read/session.ts';
import type { AnnotationsInput, UnitSpansInput } from '../read/queries.ts';
import { ReadError, limitation, type Limitation } from '../read/states.ts';
import { assembleBatch, ENVELOPE_RESERVE, type Batch, type EvidenceItem, type PassageAnnotation } from '../results/batch.ts';
import { encodeContinuation, resumeContinuation, type PositionCheck } from '../results/continuation.ts';
import { candidateUnits, contextUnits, parseReference, type PassageRequest } from '../scope/references.ts';
import { readerAlias, readerBook, readerVerses } from '../../../../packages/shared/src/reader-catalogue.ts';

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

interface BodyChunk { start: number; end: number; byte_offset: number; byte_length: number; sha256: string }
interface BodyRange { segment_ordinal: number; artifact_id: string; byte_offset: number; byte_length: number; sha256: string; chunks?: BodyChunk[] }
interface Row { evidence: SpanEvidence; order: number; ranges: BodyRange[]; artifacts: Map<string, RegisteredArtifact>; textFromD1: boolean }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function parsed(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) : undefined; } catch { return undefined; } }

async function toRow(r: Record<string, unknown>): Promise<Row> {
  const segments = parsed(r.segments_json);
  const basis = parsed(r.basis_json);
  if (!Array.isArray(segments) || !segments.length || !segments.every(s => isObject(s) && isIdentifier(s.unit_id) && isSafeCount(s.start) && isSafeCount(s.end))
      || !isObject(basis) || !isSafeCount(r.start_order ?? r.native_order))
    throw new ReadError('corrupt', 'Inconsistent verse record');
  const evidence: SpanEvidence = {
    span_id: String(r.id), source_revision_id: String(r.source_revision_id), source_name: String(r.source_name),
    attribution: String(r.source_attribution), kind: String(r.kind), label: String(r.label), native_order: Number(r.native_order),
    coordinate_version: String(r.coordinate_version), segments: segments as NativeSegment[], basis, reading_kind: String(r.reading_kind), text: null,
  };
  const row: Row = { evidence, order: (r.start_order ?? r.native_order) as number, ranges: [], artifacts: new Map(), textFromD1: false };
  if (r.content_id !== null && r.content_id !== undefined) {
    if (typeof r.exact_text !== 'string' || await sha256Hex(r.exact_text) !== r.content_id)
      throw new ReadError('corrupt', 'Text payload does not match its digest');
    evidence.text = [r.exact_text];
    row.textFromD1 = true;
  } else if (evidence.reading_kind !== 'gap') {
    const ranges = parsed(r.body_ranges_json);
    if (!Array.isArray(ranges) || ranges.length !== segments.length || ranges.some((x, i) => !isObject(x) || x.segment_ordinal !== i
        || !isIdentifier(x.artifact_id) || !isSafeCount(x.byte_offset) || !isSafeCount(x.byte_length) || x.byte_length === 0
        || typeof x.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(x.sha256)))
      throw new ReadError('corrupt', 'Body ranges are malformed or out of native segment order');
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
  const withheld = new Set<Row>();
  const withhold = (row: Row, state: Limitation['state'], detail: string) => {
    if (withheld.has(row)) return;
    withheld.add(row);
    limitations.push(limitation(state, row.evidence.label, detail));
  };
  type Piece = { row: Row; index: number; range: BodyRange; artifact: RegisteredArtifact };
  const pieces: Piece[] = [];
  for (const row of rows) row.ranges.forEach((range, index) => {
    const artifact = row.artifacts.get(range.artifact_id);
    if (!artifact) withhold(row, 'missing_evidence', 'The stored wording is not selected in the current release and is withheld');
    else pieces.push({ row, index, range, artifact });
  });
  const cap = session.budget.limits.pageBytes;
  const groups: Piece[][] = [];
  for (const piece of pieces) {
    if (withheld.has(piece.row)) continue;
    const group = groups.at(-1);
    const start = group?.[0].range.byte_offset ?? 0;
    const end = piece.range.byte_offset + piece.range.byte_length;
    if (group && group[0].artifact.id === piece.artifact.id && piece.range.byte_offset >= group.at(-1)!.range.byte_offset && end - start <= cap
        && piece.range.byte_offset - (group.at(-1)!.range.byte_offset + group.at(-1)!.range.byte_length) <= 256) group.push(piece);
    else groups.push([piece]);
  }
  const texts = new Map<Row, (string | null | undefined)[]>();
  for (const group of groups) {
    const start = group[0].range.byte_offset;
    const end = Math.max(...group.map(p => p.range.byte_offset + p.range.byte_length));
    let read: (string | null)[];
    try { read = await readSlices(session, group[0].artifact, start, end - start, group.map(p => ({ offset: p.range.byte_offset, length: p.range.byte_length, sha256: p.range.sha256 }))); }
    catch (error) {
      if (!(error instanceof ReadError)) throw error;
      // Only the verses of this read are affected; other reads and sources stay usable.
      for (const p of group) {
        if (error.state === 'budget') pending.add(p.row);
        else withhold(p.row, error.state, `${error.message}; this verse's wording is withheld`);
      }
      continue;
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
    if (withheld.has(row) || list.length !== row.ranges.length || list.some(t => typeof t !== 'string')) {
      withhold(row, 'corrupt', 'Stored wording failed its check and is withheld');
      row.evidence.text = null;
      continue;
    }
    row.evidence.text = list as string[];
  }
  return pending;
}

/** Verses missing from a requested range, per source, as readable ranges. `found` are the unit
 *  IDs a source has among the requested candidates. A chapter's real end is unknown, so verses
 *  after the last found one in a chapter are missing only up to an explicit end verse. */
export function missingRanges(ref: PassageRequest, found: string[]): string[] {
  const at = (u: string) => { const [, c, v] = u.split('.'); return [Number(c), Number(v)] as const; };
  const sorted = [...new Set(found)].map(at).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: string[] = [];
  const range = (c1: number, v1: number, c2: number, v2: number | null) =>
    out.push(v2 === null ? `${ref.book} ${c1}:${v1} to the end of chapter ${c1}` : c1 === c2 ? (v1 === v2 ? `${ref.book} ${c1}:${v1}` : `${ref.book} ${c1}:${v1}-${v2}`) : `${ref.book} ${c1}:${v1}-${c2}:${v2}`);
  const first = { c: ref.from.chapter, v: ref.from.verse ?? 1 };
  if (!sorted.length) { out.push(ref.text); return out; }
  let [pc, pv] = [first.c, first.v - 1];
  let seen = false;   // whether any asked verse was found in chapter pc
  for (const [c, v] of sorted) {
    if (c === pc && v > pv + 1) range(c, pv + 1, c, v - 1);
    else if (c > pc) {
      // Nothing found in the first chapter: its asked verses up to the chapter's end are missing.
      if (!seen) range(pc, pv + 1, pc, null);
      for (let missing = pc + 1; missing < c; missing++) out.push(`${ref.book} ${missing}`);
      if (v > 1) range(c, 1, c, v - 1);
    }
    [pc, pv] = [c, v];
    seen = true;
  }
  for (let missing = pc + 1; missing <= ref.to.chapter; missing++) out.push(`${ref.book} ${missing}`);
  if (ref.to.verse !== null && pc === ref.to.chapter && pv < ref.to.verse) range(pc, pv + 1, pc, ref.to.verse);
  return out;
}

async function annotationsFor(session: ReadSession, rows: Row[], mapped = false): Promise<Map<string, PassageAnnotation[]> | null> {
  const ids = rows.map(r => r.evidence.span_id);
  const out = new Map<string, PassageAnnotation[]>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    let after: [string, string] | null = null;
    for (;;) {
      const input: AnnotationsInput = { span_ids: chunk, after };
      const result = mapped ? await session.queryIfAvailable('mapped_annotations', input) : await session.queryIfAvailable('annotations', input);
      if (result === null) return null;
      const { rows: found, more } = result;
      for (const a of found) {
        const details = parsed(a.details_json);
        const mappedId = String(mapped ? a.mapped_span_id : a.span_id);
        const list = out.get(mappedId) ?? [];
        list.push({ kind: String(a.kind), provider: String(a.provider), details: isObject(details) ? details : {},
          ...(mapped && a.span_id !== a.mapped_span_id ? { native_span_id: String(a.span_id) } : {}) });
        out.set(mappedId, list);
      }
      if (!more || !found.length) break;
      after = [String(mapped ? found.at(-1)!.mapped_span_id : found.at(-1)!.span_id), String(found.at(-1)!.id)];
    }
  }
  return out;
}

/** One bounded batch of passage evidence: the requested verses, and (with context) the rest of
 *  their chapters, in each source's native order. Continues across batches without narrowing. */
export async function passageBatch(session: ReadSession, workload: PassageWorkload, continuation: string | null, guidanceVersion: string,
                                   notes: Limitation[] = [], rules: readonly string[] | null = null): Promise<Batch> {
  const w = normalizePassageWorkload(workload);
  if (w.mode !== 'inspect_source') {
    const batch = await readerPassageBatch(session, w, continuation, guidanceVersion, notes, rules);
    // Consecutive pieces of one literary unit can share the same host response.
    while (batch.continuation && isObject(batch.remaining) && batch.remaining.literary_unit === 'continues'
        && session.budget.canReturn(2048)) {
      let next: Batch;
      try { next = await readerPassageBatch(session, w, batch.continuation, guidanceVersion, [], null, false); }
      catch (error) { if (error instanceof ReadError && error.state === 'budget') break; throw error; }
      const currentScope = isObject(batch.context_scope) ? batch.context_scope.literary_unit : null;
      const nextScope = isObject(next.context_scope) ? next.context_scope.literary_unit : null;
      if (!isObject(currentScope) || !isObject(nextScope) || currentScope.span_id !== nextScope.span_id
          || currentScope.source_revision_id !== nextScope.source_revision_id || !next.evidence.length) break;
      const merged = { ...batch, evidence: [...batch.evidence, ...next.evidence],
        limitations: [...batch.limitations, ...next.limitations], remaining: next.remaining, continuation: next.continuation,
        context_scope: { literary_unit: { ...currentScope, last_part: nextScope.part } } };
      if (utf8Length(JSON.stringify(merged)) > session.budget.limits.resultBytes) break;
      Object.assign(batch, merged);
    }
    return batch;
  }
  if (!w.sources || w.sources.length !== 1) throw new ReadError('invalid_request', 'Native source inspection requires exactly one source revision');
  const refs: PassageRequest[] = w.references.map(parseReference);
  let pos: PassagePosition = { ref: 0, source: '', order: -1 };
  if (continuation !== null) pos = (await resumeContinuation(continuation, w, PASSAGE_CHECKS)).pos as PassagePosition;
  session.budget.spendResult(ENVELOPE_RESERVE);
  const limitations: Limitation[] = [...notes];
  const items: { item: EvidenceItem; ref: number; source: string; order: number }[] = [];
  let next: PassagePosition | null = pos;
  // Read references in order while the request allowance lasts.
  while (next) {
    if (items.length && session.budget.usage().r2Reads >= session.budget.limits.r2Reads) break;
    const ref: PassageRequest = refs[next.ref];
    const requested = new Set(candidateUnits(ref));
    const units: string[] = w.context ? contextUnits(ref) : [...requested];
    if (next.source === '' && next.order === -1) {
      // At the start of a reference: which asked verses each source has, so gaps are reported.
      const input = { units: [...requested], sources: w.sources };
      const presence = await session.queryIfAvailable('unit_presence', input);
      if (presence === null) break;
      const { rows: present } = presence;
      if (!present.length) limitations.push(limitation('missing_evidence', ref.text,
        w.sources ? 'None of the named sources has the asked verses in the current release' : 'No selected source has the asked verses in the current release'));
      else if (w.sources) {
        // A named source without any asked verse is reported, not silently left out.
        const has = new Set(present.map(row => String(row.source_revision_id)));
        for (const source of w.sources) if (!has.has(source))
          limitations.push(limitation('missing_evidence', ref.text, `${source} has none of the asked verses in the current release`));
      }
      for (const row of present) {
        const gaps = missingRanges(ref, String(row.units ?? '').split(',').filter(Boolean));
        if (gaps.length) limitations.push(limitation('missing_evidence', ref.text,
          `${String(row.source_revision_id)} has no verse ${gaps.join(', ')} in the current release`));
      }
    }
    const input: UnitSpansInput = { units, sources: w.sources, after: [next.source, next.order] };
    const spans = await session.queryIfAvailable('unit_spans', input);
    if (spans === null) break;
    const { rows: found, more } = spans;
    const rows: Row[] = [];
    for (const r of found) {
      try { rows.push(await toRow(r)); }
      catch (error) { if (error instanceof ReadError) limitations.push(limitation(error.state, String(r.label ?? r.id), error.message)); else throw error; }
    }
    const pending = await fillBodies(session, rows, limitations);
    // A verse is never delivered after one whose wording is still unread: stop at the first pending verse.
    const firstPending = rows.findIndex(r => pending.has(r));
    const deliverable = firstPending < 0 ? rows : rows.slice(0, firstPending);
    const annotations = deliverable.length ? await annotationsFor(session, deliverable) : new Map<string, PassageAnnotation[]>();
    if (annotations === null) {
      // Verses are not delivered without their notes: the next batch reads them again with notes.
      if (items.length) break;
      limitations.push(limitation('budget', 'annotations', 'Textual notes for these verses could not be read and are not supplied'));
    }
    for (const row of deliverable) {
      const item: EvidenceItem = { kind: 'source_text', span: row.evidence,
        role: requested.has(row.evidence.segments[0].unit_id) ? 'requested' : 'context',
        ...(annotations ? { annotations: annotations.get(row.evidence.span_id) ?? [] } : {}) };
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
    remaining: null, continuation: null, guidance_version: guidanceVersion, ...(rules ? { translation_rules: rules } : {}),
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

type MappingKey = [number, string, number, number, string, string];
const mappingKey = (row: Record<string, unknown>): MappingKey => [Number(row.position), String(row.source_revision_id), Number(row.role_order), Number(row.ordinal), String(row.mapping_id), row.span_id == null ? '' : String(row.span_id)];

/** Unmapped same-number native text is returned only as an explicitly unverified candidate. */
async function readerPassageBatch(session: ReadSession, w: PassageWorkload, continuation: string | null, guidanceVersion: string,
                                  notes: Limitation[], rules: readonly string[] | null, reserve = true): Promise<Batch> {
  if (session.release.schema_versions.reader_scheme_version !== 'nrsva/1')
    throw new ReadError('unresolved_mapping', 'The current release does not contain the NRSVA reader catalogue; use source-qualified inspection');
  const refs = w.references.map(parseReference);
  const requested = new Set<string>();
  const numberingNotes: string[] = [];
  const references = refs.flatMap(ref => {
    const book = readerBook(ref.book);
    if (!book) throw new ReadError('invalid_request', `Unknown reader catalogue book ${ref.book}`);
    let verses: string[];
    try {
      const fromAlias = readerAlias(book, ref.from), toAlias = readerAlias(book, ref.to);
      for (const alias of [fromAlias, toAlias]) if (alias && !numberingNotes.includes(alias.note)) numberingNotes.push(alias.note);
      const resolved = (point: typeof ref.from, alias: typeof fromAlias) => {
        if (!alias) return point;
        const [, chapter, verse] = alias.to.split('.');
        return { chapter: Number(chapter), verse: Number(verse) };
      };
      const from = resolved(ref.from, fromAlias), to = resolved(ref.to, toAlias);
      for (const verse of readerVerses(book, from, to)) requested.add(verse);
      verses = w.context ? readerVerses(book, { chapter: ref.from.chapter, verse: null }, { chapter: ref.to.chapter, verse: null })
        : readerVerses(book, from, to);
    }
    catch { throw new ReadError('invalid_request', `Reference ${ref.text} is outside the NRSVA catalogue`); }
    const aliases = [book.book_id, ...book.aliases].filter(alias => /^[1-4]?[A-Za-z][A-Za-z0-9]*$/.test(alias));
    return verses.map(reader_ref => {
      const [, chapter, verse] = reader_ref.split('.');
      return { ref: reader_ref, book: book.book_id, chapter: Number(chapter), verse: Number(verse),
        native_units: [...new Set(aliases.map(alias => `${alias}.${chapter}.${verse}`))] };
    });
  });
  if (references.length > 540) throw new ReadError('exceeds_limits', 'The requested references are too long');
  const checks: Readonly<Record<string, PositionCheck>> = { reader(pos, key) {
    return key === null && Array.isArray(pos) && pos.length === 6 && Number.isSafeInteger(pos[0]) && pos[0] >= -1 && pos[0] < references.length
      && (pos[1] === '' || isIdentifier(pos[1])) && Number.isSafeInteger(pos[2]) && pos[2] >= -1 && pos[2] <= 1
      && Number.isSafeInteger(pos[3]) && pos[3] >= -1 && (pos[4] === '' || isIdentifier(pos[4])) && (pos[5] === '' || isIdentifier(pos[5]));
  }, literary(pos, key) {
    return key === null && w.context && Array.isArray(pos) && pos.length === 4
      && (pos[0] === '' || isIdentifier(pos[0])) && (pos[1] === '' || isIdentifier(pos[1]))
      && Number.isSafeInteger(pos[2]) && pos[2] >= -1 && pos[2] <= 100000 && isSafeCount(pos[3]);
  } };
  const state = continuation ? await resumeContinuation(continuation, w, checks) : null;
  const start: MappingKey = state?.op === 'reader' ? state.pos as MappingKey : [-1, '', -1, -1, '', ''];
  if (reserve) session.budget.spendResult(ENVELOPE_RESERVE);
  if (w.context && (!state || state.op === 'literary')) {
    const cursor: [string, string, number, number] = state?.op === 'literary' ? state.pos as [string, string, number, number] : ['', '', -1, 0];
    const contextReferences = references.filter(ref => requested.has(ref.ref));
    const context = await session.queryIfAvailable('literary_contexts', { references: contextReferences, scheme: 'nrsva/1', sources: w.sources,
      after: [cursor[0], cursor[1]], include_current: cursor[2] >= 0 });
    if (context === null) throw new ReadError('budget', 'Literary-unit lookup could not be read within this request');
    if (context.rows.length) {
      const unit = context.rows[0];
      const unitId = String(unit.span_id), source = String(unit.source_revision_id);
      const part = cursor[2] >= 0 && cursor[0] === source && cursor[1] === unitId ? cursor[2] : 0;
      const within = part === cursor[2] && cursor[0] === source && cursor[1] === unitId ? cursor[3] : 0;
      try {
      const found = await session.queryIfAvailable('spans', { ids: [unitId] });
      if (found === null) throw new ReadError('budget', 'Literary-unit text could not be read within this request');
      if (!found.rows.length) throw new ReadError('missing_evidence', 'The literary unit is not selected in the current release');
      const row = await toRow(found.rows[0]);
      if (row.evidence.kind !== 'literary_unit' || row.evidence.source_revision_id !== source || part >= row.evidence.segments.length)
        throw new ReadError('invalid_request', 'The literary-unit continuation is outside the selected unit');
      const segment = row.evidence.segments[part];
      const piece: Row = { ...row, evidence: { ...row.evidence, segments: [segment], text: null }, ranges: [] };
      let textStart = 0;
      if (row.textFromD1) {
        const chars = Array.from(row.evidence.text![0]);
        const lengths = row.evidence.segments.map(s => s.end - s.start);
        if (lengths.reduce((a, b) => a + b, 0) !== chars.length) throw new ReadError('corrupt', 'Literary-unit text does not match its ordered segments');
        const offset = lengths.slice(0, part).reduce((a, b) => a + b, 0);
        piece.evidence.text = [chars.slice(offset, offset + lengths[part]).join('')];
      } else if (row.ranges.length) {
        const range = row.ranges[part];
        const artifact = row.artifacts.get(range.artifact_id);
        if (!artifact) throw new ReadError('missing_evidence', 'The stored wording is not selected in the current release');
        if (range.chunks !== undefined) {
          if (!Array.isArray(range.chunks) || !range.chunks.length) throw new ReadError('corrupt', 'Literary-unit chunks are malformed');
          let bytePos = range.byte_offset, scalarPos = 0;
          for (const chunk of range.chunks) {
            if (!isObject(chunk) || !isSafeCount(chunk.start) || !isSafeCount(chunk.end) || chunk.start !== scalarPos || chunk.end <= chunk.start
                || chunk.byte_offset !== bytePos || !isSafeCount(chunk.byte_length) || !chunk.byte_length
                || typeof chunk.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(chunk.sha256))
              throw new ReadError('corrupt', 'Literary-unit chunks are inconsistent');
            scalarPos = chunk.end; bytePos += chunk.byte_length;
          }
          if (scalarPos !== segment.end - segment.start || bytePos !== range.byte_offset + range.byte_length)
            throw new ReadError('corrupt', 'Literary-unit chunks do not cover the segment');
          const first = range.chunks.findIndex(c => c.start <= within && within < c.end);
          if (first < 0) throw new ReadError('invalid_request', 'Literary-unit offset is outside the segment');
          const selected: BodyChunk[] = [];
          const offset = range.chunks[first].byte_offset;
          const cap = Math.min(session.budget.limits.pageBytes, 8192);
          for (const chunk of range.chunks.slice(first)) {
            const length = chunk.byte_offset + chunk.byte_length - offset;
            if (length > cap || !session.budget.canRead(length, 'page')) break;
            selected.push(chunk);
          }
          if (!selected.length) throw new ReadError('budget', 'Literary-unit chunks cannot fit the read allowance');
          textStart = selected[0].start;
          const length = selected.at(-1)!.byte_offset + selected.at(-1)!.byte_length - offset;
          const texts = await readSlices(session, artifact, offset, length,
            selected.map(c => ({ offset: c.byte_offset, length: c.byte_length, sha256: c.sha256 })));
          if (texts.some((value, i) => value === null || Array.from(value).length !== selected[i].end - selected[i].start))
            throw new ReadError('corrupt', 'Literary-unit chunk failed its integrity check');
          piece.evidence.text = [texts.join('')];
        } else {
          piece.evidence.text = [await readVerifiedRange(session, artifact, { offset: range.byte_offset, length: range.byte_length, sha256: range.sha256 })];
        }
      }
      const limitations: Limitation[] = [...notes];
      if (piece.evidence.text) {
        const chars = Array.from(piece.evidence.text[0]);
        if (row.textFromD1 || !row.ranges[part]?.chunks) {
          if (chars.length !== segment.end - segment.start) throw new ReadError('corrupt', 'Literary-unit text does not match its native segment');
        }
        if (within < textStart || within >= textStart + chars.length) throw new ReadError('invalid_request', 'Literary-unit offset is outside the segment');
        // Bound the encoded JSON wording, including escaping, leaving room for the envelope.
        const textBudget = Math.max(1, Math.min(8192, session.budget.limits.resultBytes - session.budget.usage().resultBytes - 2048));
        let low = within, high = textStart + chars.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (utf8Length(JSON.stringify(chars.slice(within - textStart, mid - textStart).join(''))) <= textBudget) low = mid;
          else high = mid - 1;
        }
        const end = low;
        if (end === within) throw new ReadError('exceeds_limits', 'One literary-unit character does not fit a result batch');
        piece.evidence.text = [chars.slice(within - textStart, end - textStart).join('')];
        piece.evidence.segments = [{ ...segment, start: segment.start + within, end: segment.start + end }];
      }
      const item: EvidenceItem = { kind: 'source_text', span: piece.evidence, role: 'context', literary_part: part + 1 };
      const { batch, deferred } = assembleBatch({ release_id: session.release.id, mode: w.mode, depth: w.depth,
        delivered_scope: { references: w.references, sources: w.sources ?? 'all selected', ...(numberingNotes.length ? { numbering_notes: numberingNotes } : {}) },
        context_scope: { literary_unit: { source_revision_id: source, span_id: unitId,
          basis: row.evidence.basis, part: part + 1, parts: row.evidence.segments.length } },
        evidence: [item], citations: [], searched_scope: [], coverage: [], limitations,
        remaining: null, continuation: null, guidance_version: guidanceVersion, ...(rules ? { translation_rules: rules } : {}) }, session.budget);
      if (deferred.length) throw new ReadError('exceeds_limits', 'One literary-unit segment does not fit a result batch');
      const nextOffset = piece.evidence.segments[0].end - segment.start;
      const segmentComplete = nextOffset === segment.end - segment.start;
      const lastPart = segmentComplete && part + 1 === row.evidence.segments.length;
      const next = lastPart ? [source, unitId, -1, 0] : segmentComplete ? [source, unitId, part + 1, 0] : [source, unitId, part, nextOffset];
      batch.continuation = lastPart && !context.more
        ? await encodeContinuation(w, { op: 'reader', pos: [-1, '', -1, -1, '', ''], key: null })
        : await encodeContinuation(w, { op: 'literary', pos: next, key: null });
      batch.remaining = { passage: 'continues', literary_unit: lastPart ? 'complete' : 'continues' };
      return batch;
      } catch (error) {
        if (!(error instanceof ReadError) || !['corrupt', 'missing_evidence', 'exceeds_limits'].includes(error.state)) throw error;
        const { batch } = assembleBatch({ release_id: session.release.id, mode: w.mode, depth: w.depth,
          delivered_scope: { references: w.references, sources: w.sources ?? 'all selected', ...(numberingNotes.length ? { numbering_notes: numberingNotes } : {}) }, context_scope: {},
          evidence: [], citations: [], searched_scope: [], coverage: [],
          limitations: [...notes, limitation(error.state, unitId, `${error.message}; literary-unit context is withheld`)],
          remaining: { passage: 'continues' }, continuation: null, guidance_version: guidanceVersion,
          ...(rules ? { translation_rules: rules } : {}) }, session.budget);
        batch.continuation = context.more
          ? await encodeContinuation(w, { op: 'literary', pos: [source, unitId, -1, 0], key: null })
          : await encodeContinuation(w, { op: 'reader', pos: [-1, '', -1, -1, '', ''], key: null });
        return batch;
      }
    }
    if (!state) notes.push(limitation('missing_evidence', 'literary_unit', 'No selected literary-unit boundary matched the requested text; the mapped chapter supplies context'));
  }
  const page = await session.queryIfAvailable('reader_mappings', { references, scheme: 'nrsva/1', sources: w.sources, after: start });
  if (!page) throw new ReadError('budget', 'Reader mapping lookup could not be read within this request');
  const limits: Limitation[] = [...notes];
  if (!page.rows.length && start[0] === -1) limits.push(limitation('unresolved_mapping', w.references.join(', '), 'No checked reader mappings are available for these references and sources'));
  const ids = [...new Set(page.rows.map(row => row.span_id).filter(value => isIdentifier(value)))] as string[];
  const found = ids.length ? await session.queryIfAvailable('spans', { ids }) : { rows: [], more: false };
  if (found === null) throw new ReadError('budget', 'Mapped spans could not be read within this request');
  const rows = new Map<string, Row>();
  for (const row of found.rows) {
    try { const parsedRow = await toRow(row); rows.set(parsedRow.evidence.span_id, parsedRow); }
    catch (error) { if (error instanceof ReadError) limits.push(limitation(error.state, String(row.id), error.message)); else throw error; }
  }
  const pending = await fillBodies(session, ids.map(id => rows.get(id)).filter((row): row is Row => row !== undefined), limits);
  const annotations = rows.size ? await annotationsFor(session, [...rows.values()], true) : new Map<string, PassageAnnotation[]>();
  if (annotations === null) limits.push(limitation('budget', 'annotations', 'Textual notes were not supplied'));
  const items: { item: EvidenceItem; key: MappingKey }[] = [];
  const mappingLimits: { index: number; limit: Limitation }[] = [];
  let processed = start;
  for (const [index, mapping] of page.rows.entries()) {
    const key = mappingKey(mapping);
    if (!mapping.span_id) {
      const limit = limitation(mapping.status === 'uncovered' ? 'missing_evidence' : 'unresolved_mapping', String(mapping.reader_ref),
        `${String(mapping.source_revision_id)}: ${String(mapping.gap_reason ?? 'The mapped native span is not selected')}`);
      limits.push(limit); mappingLimits.push({ index, limit });
      processed = key; continue;
    }
    const row = rows.get(String(mapping.span_id));
    if (row && pending.has(row)) break;
    if (!row) {
      const limit = limitation('missing_evidence', String(mapping.reader_ref), 'Mapped span was unavailable or invalid');
      limits.push(limit); mappingLimits.push({ index, limit }); processed = key; continue;
    }
    const candidate = mapping.status === 'native_candidate';
    const item: EvidenceItem = { kind: 'source_text', span: row.evidence, role: requested.has(String(mapping.reader_ref)) ? 'requested' : 'context',
      ...(candidate ? {} : { reader_reference: String(mapping.reader_ref), display_role: mapping.role === 'superscription' ? 'superscription' as const : 'numbered_text' as const }),
      mapping_status: String(mapping.status), mapping_basis: parsed(mapping.basis_json),
      ...(annotations ? { annotations: annotations.get(row.evidence.span_id) ?? [] } : {}) };
    if (candidate) {
      const limit = limitation('missing_evidence', String(mapping.reader_ref), `${row.evidence.source_revision_id}: No checked mapping with selected native evidence is available`);
      limits.push(limit); mappingLimits.push({ index, limit });
    }
    items.push({ item, key }); processed = key;
  }
  const { batch, deferred } = assembleBatch({ release_id: session.release.id, mode: w.mode, depth: w.depth,
    delivered_scope: { references: w.references, sources: w.sources ?? 'all selected', ...(numberingNotes.length ? { numbering_notes: numberingNotes } : {}) }, context_scope: w.context ? { chapters: refs.map(r => `${r.book} ${r.from.chapter}`) } : null,
    evidence: items.map(i => i.item), citations: [], searched_scope: [], coverage: [], limitations: limits,
    remaining: null, continuation: null, guidance_version: guidanceVersion, ...(rules ? { translation_rules: rules } : {}) }, session.budget);
  const delivered = items.length - deferred.length;
  let last = processed;
  if (deferred.length) {
    const firstDeferredKey = items[delivered].key;
    const cutoff = page.rows.findIndex(row => JSON.stringify(mappingKey(row)) === JSON.stringify(firstDeferredKey));
    if (cutoff < 0) throw new ReadError('corrupt', 'Deferred mapping is not in the current page');
    const laterLimits = new Set(mappingLimits.filter(entry => entry.index >= cutoff).map(entry => entry.limit));
    batch.limitations = batch.limitations.filter(limit => !laterLimits.has(limit));
    // Gaps before the deferred evidence were already reported, so resume after them.
    last = cutoff > 0 ? mappingKey(page.rows[cutoff - 1]) : start;
  }
  const more = deferred.length > 0 || pending.size > 0 || page.more;
  if (more && JSON.stringify(last) === JSON.stringify(start)) throw new ReadError('exceeds_limits', 'No mapping fits in this request');
  if (page.more) batch.limitations.push(limitation('budget', 'mapping', 'The final reference group may be incomplete until continuation'));
  batch.continuation = more ? await encodeContinuation(w, { op: 'reader', pos: last, key: null }) : null;
  batch.remaining = more ? { passage: 'continues' } : null;
  return batch;
}
