import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, entriesOf, A, B, type Fixture } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { STARTING_LIMITS, RequestBudget } from '../../services/study/src/read/budget.ts';
import { readSpans } from '../../services/study/src/read/evidence.ts';
import { compareUtf8 } from '../../services/study/src/read/bytes.ts';
import { PagedIndexSearch, checkRequest, clearSearchCache, hitBytes, type SearchAdapter, type SearchHit, type SearchRequest, type SearchResult } from '../../services/study/src/read/search.ts';
import { ReadError } from '../../services/study/src/read/states.ts';
import { assembleBatch, type Batch } from '../../services/study/src/results/batch.ts';
import { encodeContinuation, resumeContinuation } from '../../services/study/src/results/continuation.ts';
import { SEARCH_CHECKS, searchBatch, type SearchWorkload } from '../../services/study/src/results/search-batch.ts';

const roomy = { ...STARTING_LIMITS, d1Calls: 10, r2Reads: 40, r2Bytes: 1 << 20, resultBytes: 1 << 20 };
const state = (s: string) => (error: unknown) => error instanceof ReadError && error.state === s;
const workload: SearchWorkload = { mode: 'word_study', depth: 'standard', language: 'en', lookup: 'word', key: 'common', sources: [A] };
const checks = { op: () => true };

async function drain(fixture: Fixture, adapter: SearchAdapter, w: SearchWorkload) {
  const batches: Batch[] = [];
  let continuation: string | null = null;
  for (let i = 0; i < 100; i++) {
    const session = await ReadSession.open(fixture.env, STARTING_LIMITS);
    const batch = await searchBatch(session, adapter, w, continuation, 'guidance-test/1');
    batches.push(batch);
    continuation = batch.continuation;
    if (!continuation) break;
  }
  return batches;
}

test('continuation round-trips for the same workload and needs no signing secret', async () => {
  const token = await encodeContinuation(workload, { op: 'op', pos: { n: 1 }, key: [3, 'x'] });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await resumeContinuation(token, workload, checks), { op: 'op', pos: { n: 1 }, key: [3, 'x'] });
});

test('malformed, foreign or out-of-bounds continuations are rejected', async () => {
  const token = await encodeContinuation(workload, { op: 'op', pos: {}, key: null });
  const bad: unknown[] = [null, 42, '', '***', 'x'.repeat(5000), btoa('{"v":1}'), token.slice(0, -4) + 'AAAA'];
  for (const t of bad) await assert.rejects(resumeContinuation(t, workload, checks), state('invalid_request'), String(t).slice(0, 20));
  await assert.rejects(resumeContinuation(token, { ...workload, key: 'other' }, checks), state('invalid_request'));
  await assert.rejects(resumeContinuation(token, workload, { other: () => true }), state('invalid_request'));
  await assert.rejects(resumeContinuation(token, workload, { op: () => false }), state('invalid_request'));
  await assert.rejects(resumeContinuation(await encodeContinuation(workload, { op: 'constructor', pos: {}, key: null }), workload, checks), state('invalid_request'));
});

test('a search batch continues to completion; every continuation resolves current anew', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const batches = await drain(fixture, new PagedIndexSearch(), workload);
  const hits = batches.flatMap(b => b.evidence.map(e => e.kind === 'search_hit' ? e.hit.occurrence_id : ''));
  assert.equal(hits.length, 48);
  assert.equal(new Set(hits).size, 48);
  assert.ok(batches.every(b => b.release_id === 'rel-2' && b.guidance_version === 'guidance-test/1'));
  assert.ok(batches.slice(0, -1).every(b => b.continuation && b.remaining));
  assert.equal(batches.at(-1)!.remaining, null);
  for (const key of ['release_id', 'mode', 'depth', 'delivered_scope', 'context_scope', 'evidence', 'citations', 'searched_scope', 'coverage', 'limitations', 'remaining', 'continuation', 'guidance_version'])
    assert.ok(Object.hasOwn(batches[0], key), key);
});

test('after promotion or rollback a continuation resolves current anew and rejects a stale anchor', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const first = await searchBatch(await ReadSession.open(fixture.env, STARTING_LIMITS), new PagedIndexSearch(), workload, null, 'g/1');
  fixture.select('rel-1', 'rel-2');   // the anchored index output is no longer selected
  await assert.rejects(searchBatch(await ReadSession.open(fixture.env, roomy), new PagedIndexSearch(), workload, first.continuation, 'g/1'),
    (e: unknown) => e instanceof ReadError && e.state === 'invalid_request' && /start the search again/.test(e.message));
  fixture.select('rel-2', 'rel-1');   // selected again: the same continuation is valid
  const next = await searchBatch(await ReadSession.open(fixture.env, STARTING_LIMITS), new PagedIndexSearch(), workload, first.continuation, 'g/1');
  assert.equal(next.release_id, 'rel-2');
  assert.ok(next.evidence.length > 0);
});

test('tampered continuation positions cannot escape the workload or the index bounds', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const tamper = [
    { source: B, output: 'syn-src-b', order: 0, dir: 0, entry: 0, anchor: null },          // source outside the workload
    { source: A, output: 'syn-src-1', order: 0, dir: 0, entry: 9999, anchor: null },       // mid-output without an order key
    { source: A, output: 'syn-src-1', order: 0, dir: 0, entry: 0, anchor: null, extra: 1 },
  ];
  for (const pos of tamper) {
    const token = await encodeContinuation(workload, { op: 'search', pos, key: null });
    await assert.rejects(searchBatch(await ReadSession.open(fixture.env, roomy), new PagedIndexSearch(), workload, token, 'g/1'), state('invalid_request'), JSON.stringify(pos));
  }
  // Invented anchors: unselected or high output names, a wrong order position, a next page that does not
  // follow the anchor page, an order key the anchor page does not hold, and an anchor range that is not a page.
  const entries = entriesOf(fixture.indexes['syn-src-1']).filter(e => e.first_key <= 'common' && 'common' <= e.last_key);
  const [p0, p1, p2] = entries;
  const ref = (e: typeof p0) => ({ file: e.postings_artifact_id, offset: e.byte_offset, length: e.byte_length, sha256: e.sha256 });
  const onP0 = fixture.postings['syn-src-1'].filter(p => p.search_key === 'common')[0];
  const at = (next: typeof p0, anchor: ReturnType<typeof ref>) => ({ source: A, output: 'syn-src-1', order: 0, dir: next.dir, entry: next.entry, anchor });
  const forged = [
    { pos: { source: A, output: '../x', order: 0, dir: 0, entry: 0, anchor: null }, key: null },
    { pos: { source: A, output: 'zzz-after-everything', order: 0, dir: 0, entry: 0, anchor: null }, key: null },
    { pos: { source: A, output: 'syn-src-1', order: 5, dir: 0, entry: 0, anchor: null }, key: null },
    { pos: at(p2, ref(p0)), key: [onP0.native_order, onP0.occurrence_id] },                                  // skips p1
    { pos: at(p1, ref(p0)), key: [9_000_000, 'occ-x'] },                                                      // not on p0
    { pos: at(p1, ref(p0)), key: [onP0.native_order, `${onP0.occurrence_id}-forged`] },
    { pos: at(p1, { ...ref(p0), sha256: 'f'.repeat(64) }), key: [onP0.native_order, onP0.occurrence_id] },    // not a real page
    { pos: at(p1, { ...ref(p0), offset: ref(p0).offset + 1, length: ref(p0).length - 1 }), key: [onP0.native_order, onP0.occurrence_id] },
  ];
  assert.ok(p2, 'the key spans at least three pages');
  for (const { pos, key } of forged) {
    const token = await encodeContinuation(workload, { op: 'search', pos, key });
    await assert.rejects(searchBatch(await ReadSession.open(fixture.env, roomy), new PagedIndexSearch(), workload, token, 'g/1'),
      state('invalid_request'), JSON.stringify(pos));
  }
  assert.equal(SEARCH_CHECKS.search(at(p1, ref(p0)), [1, 'occ'], workload), true);
  assert.equal(SEARCH_CHECKS.search(at(p1, ref(p0)), [-1, 'occ'], workload), false);
  assert.equal(SEARCH_CHECKS.search({ ...at(p1, ref(p0)), anchor: null }, [1, 'occ'], workload), false);
});

test('citations must match supplied evidence; equal wording from two sources stays separate', async () => {
  const fixture = buildFixture();
  fixture.select(null);   // selected outputs are immutable; add the synthetic duplicate before selecting
  fixture.db.sqlite.exec(`INSERT INTO native_spans (id, output_id, source_revision_id, parent_id, kind, label, native_order, coordinate_version, segments_json, basis_json, content_id, body_ranges_json, reading_kind)
    SELECT 'b-dup', 'syn-ev-b', '${B}', NULL, 'verse', 'B dup', 1, coordinate_version, segments_json, basis_json, content_id, '[]', 'preserved' FROM native_spans WHERE id = 'a-u1'`);
  fixture.select('rel-2', 'rel-1');
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'b-dup']);
  assert.equal(read.spans.length, 2);
  const [a, b] = read.spans;
  assert.equal(a.text![0], b.text![0]);
  const { batch } = assembleBatch({
    release_id: session.release.id, mode: 'passage', depth: 'standard', delivered_scope: null, context_scope: null,
    evidence: read.spans.map(span => ({ kind: 'source_text' as const, span })), searched_scope: [], coverage: [], remaining: null, continuation: null,
    guidance_version: 'g/1', limitations: read.limitations,
    citations: [
      { source_revision_id: A, span_id: 'a-u1', coordinate_version: a.coordinate_version, segments: [{ unit_id: 'u1', start: 0, end: 5 }], quote: 'alpha beta' },
      { source_revision_id: B, span_id: 'a-u1', coordinate_version: a.coordinate_version, segments: a.segments },          // wrong source
      { source_revision_id: A, span_id: 'a-u1', coordinate_version: a.coordinate_version, segments: a.segments, quote: 'not there' },
      { source_revision_id: A, span_id: 'a-u1', coordinate_version: a.coordinate_version, segments: [{ unit_id: 'u2', start: 0, end: 1 }] },
    ],
  }, session.budget);
  assert.deepEqual(batch.evidence.map(e => e.kind === 'source_text' && [e.span.source_revision_id, e.span.attribution]),
    [[A, 'Synthetic source A, synthetic attribution'], [B, 'Synthetic source B, synthetic attribution']]);
  assert.equal(batch.citations.length, 1);
  assert.deepEqual(batch.limitations.map(l => l.scope), ['citations']);
});

test('evidence beyond the result allowance is deferred in order, never dropped', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'a-u2', 'a-unit']);
  const budget = new RequestBudget({ ...roomy, resultBytes: 1100 });
  const { batch, deferred } = assembleBatch({ release_id: 'rel-2', mode: 'passage', depth: 'standard', delivered_scope: null, context_scope: null,
    evidence: read.spans.map(span => ({ kind: 'source_text' as const, span })), citations: [], searched_scope: [], coverage: [], limitations: [],
    remaining: null, continuation: null, guidance_version: 'g/1' }, budget);
  assert.ok(batch.evidence.length >= 1 && deferred.length >= 1);
  assert.deepEqual([...batch.evidence, ...deferred].map(e => e.kind === 'source_text' && e.span.span_id), ['a-u1', 'a-u2', 'a-unit']);
  assert.equal(batch.limitations.at(-1)?.state, 'budget');
});

/** Contract-faithful replacement: plain in-memory postings, no R2 pages or manifests.
 *  It honours the same request checks, order, allowance charging and position semantics. */
class MemorySearch implements SearchAdapter {
  readonly hits: Record<string, SearchHit[]>;
  readonly perRequest: number;
  constructor(hits: Record<string, SearchHit[]>, perRequest: number) { this.hits = hits; this.perRequest = perRequest; }
  async search(session: ReadSession, input: SearchRequest): Promise<SearchResult> {
    const request = checkRequest(input);
    const base = { lookup: request.lookup, key: request.key, searched: [], limitations: [], ranked: false as const };
    if (['phrase', 'proximity', 'fuzzy'].includes(request.lookup))
      return { ...base, state: 'unsupported_capability', hits: [], remaining: null, resume_after: [],
        limitations: [{ state: 'unsupported_capability', scope: request.lookup, detail: 'not offered' }] };
    const all = (this.hits[request.key] ?? []).filter(h => request.sources.includes(h.source_revision_id))
      .sort((x, y) => compareUtf8(x.source_revision_id, y.source_revision_id) || x.native_order - y.native_order || compareUtf8(x.occurrence_id, y.occurrence_id));
    const after = request.position?.after;
    const start = after ? all.findIndex(h => h.native_order > after[0] || (h.native_order === after[0] && compareUtf8(h.occurrence_id, after[1]) > 0)) : 0;
    const slice = (start < 0 ? [] : all.slice(start)).slice(0, this.perRequest);
    for (const hit of slice) session.budget.spendResult(hitBytes(hit));
    const rest = start >= 0 && start + slice.length < all.length;
    const last = slice.at(-1);
    return { ...base, hits: slice, state: rest ? 'continues' : slice.length ? 'complete' : 'no_match',
      searched: request.sources.map(s => ({ source_revision_id: s, capability: 'word_exact', coverage_state: 'available', unit_count: 2, first_unit: 'u1', last_unit: 'u2',
        order_range: [0, 19999] as [number, number], normalization_rule: 'syn:identity/1', complete: !rest, resumed_after: request.position?.after ?? null })),
      resume_after: slice.map(h => ({ source: h.source_revision_id, output: 'memory', order: 0, dir: 0, entry: 0, after: [h.native_order, h.occurrence_id] as [number, string],
        anchor: { file: 'memory', offset: 0, length: 1, sha256: '0'.repeat(64) } })),
      remaining: rest && last ? { source: last.source_revision_id, output: 'memory', order: 0, dir: 0, entry: 0, after: [last.native_order, last.occurrence_id],
        anchor: { file: 'memory', offset: 0, length: 1, sha256: '0'.repeat(64) } } : null };
  }
}

test('a contract-faithful replacement adapter yields the same hits through the same batch contract', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const paged = await drain(fixture, new PagedIndexSearch(), workload);
  const memoryHits = fixture.postings['syn-src-1'].filter(p => p.search_key === 'common').map(p => ({
    source_revision_id: p.source_revision_id, span_id: p.span_id, coordinate_version: p.coordinate_version,
    native_order: p.native_order, occurrence_id: p.occurrence_id, native_reference: p.native_reference }));
  const memory = await drain(fixture, new MemorySearch({ common: memoryHits }, 5), workload);
  const ids = (batches: Batch[]) => batches.flatMap(b => b.evidence.map(e => e.kind === 'search_hit' ? e.hit.occurrence_id : ''));
  assert.deepEqual(ids(memory), ids(paged));
  assert.deepEqual(Object.keys(memory[0]).sort(), Object.keys(paged[0]).sort());
  const unsupported = await searchBatch(await ReadSession.open(fixture.env, roomy), new MemorySearch({}, 5), { ...workload, lookup: 'phrase' }, null, 'g/1');
  assert.deepEqual(unsupported.limitations.map(l => l.state), ['unsupported_capability']);
});

test('every batch, envelope included, fits the result allowance', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const batches = await drain(fixture, new PagedIndexSearch(), workload);
  for (const batch of batches) assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= STARTING_LIMITS.resultBytes);
  assert.equal(batches.at(-1)!.remaining, null);
});

test('a large envelope defers uncharged evidence instead of exceeding the allowance', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'a-u2']);
  const many = Array.from({ length: 30 }, (_, i) => ({ state: 'missing_index' as const, scope: `source-${i}`, detail: 'synthetic limitation text' }));
  const base = { release_id: 'rel-2', mode: 'passage', depth: 'standard', delivered_scope: null, context_scope: null, citations: [],
    searched_scope: [], coverage: [], limitations: many, remaining: null, continuation: null, guidance_version: 'g/1' };
  const items = read.spans.map(span => ({ kind: 'source_text' as const, span }));
  // Room for the envelope and the first item only; per-item charging alone would admit both.
  const cap = Buffer.byteLength(JSON.stringify({ ...base, evidence: [items[0]] })) + 200;
  const { batch, deferred } = assembleBatch({ ...base, evidence: items }, new RequestBudget({ ...roomy, resultBytes: cap }));
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= cap);
  assert.ok(deferred.length >= 1);
  assert.throws(() => assembleBatch({ release_id: 'rel-2', mode: 'passage', depth: 'standard', delivered_scope: null, context_scope: null,
    evidence: [], citations: [], searched_scope: [], coverage: [], limitations: many, remaining: null, continuation: null, guidance_version: 'g/1' },
    new RequestBudget({ ...roomy, resultBytes: 500 })), state('exceeds_limits'));
});

test('R30-3: a large envelope (many sources and limitations) delivers fewer hits and continues exactly', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const absent = Array.from({ length: 18 }, (_, i) => `syn:absent-${String(i).padStart(2, '0')}:source_revision-with-a-long-identifier`);
  const many: SearchWorkload = { ...workload, sources: [A, ...absent] };
  const limits = { ...STARTING_LIMITS, resultBytes: 7000 };
  const batches: Batch[] = [];
  let continuation: string | null = null;
  for (let i = 0; i < 200; i++) {
    const batch = await searchBatch(await ReadSession.open(fixture.env, limits), new PagedIndexSearch(), many, continuation, 'g/1');
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= limits.resultBytes, `batch ${i} fits`);
    batches.push(batch);
    continuation = batch.continuation;
    if (!continuation) break;
  }
  assert.equal(batches[0].limitations.filter(l => l.state === 'missing_index').length, 18);
  assert.ok(batches[0].limitations.some(l => l.state === 'budget' && l.scope === 'evidence'), 'the first batch delivered fewer hits than it read');
  const ids = batches.flatMap(b => b.evidence.map(e => e.kind === 'search_hit' ? e.hit.occurrence_id : ''));
  const want = fixture.postings['syn-src-1'].filter(p => p.search_key === 'common').map(p => p.occurrence_id).sort();
  assert.deepEqual([...ids].sort(), want);
  assert.equal(new Set(ids).size, ids.length);
});

test('R30-7: removing an uncharged item never defers charged evidence', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'a-u2']);
  const charged = { kind: 'search_hit' as const, hit: { source_revision_id: A, span_id: 'a-u1', coordinate_version: 'c', native_order: 0, occurrence_id: 'o',
    native_reference: { schema_version: 'native-reference/1', source_revision_id: A, coordinate_version: 'c', segments: [{ unit_id: 'u1', start: 0, end: 1 }] } } };
  const items = [{ kind: 'source_text' as const, span: read.spans[0] }, charged, { kind: 'source_text' as const, span: read.spans[1] }];
  const base = { release_id: 'rel-2', mode: 'passage', depth: 'standard', delivered_scope: null, context_scope: null, citations: [], searched_scope: [],
    coverage: [], limitations: [], remaining: null, continuation: null, guidance_version: 'g/1' };
  const cap = Buffer.byteLength(JSON.stringify({ ...base, evidence: [charged] })) + 150;
  const { batch, deferred } = assembleBatch({ ...base, evidence: items, charged: new Set([charged]) }, new RequestBudget({ ...roomy, resultBytes: cap }));
  assert.ok(batch.evidence.includes(charged));
  assert.ok(!deferred.includes(charged));
  assert.equal(deferred.length, 2);
});
