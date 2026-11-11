import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, A, B, type Fixture } from './fixture.ts';
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
  const fixture = buildFixture({ pageCap: 1024, commonCount: 24 });
  const batches = await drain(fixture, new PagedIndexSearch(), workload);
  const hits = batches.flatMap(b => b.evidence.map(e => e.kind === 'search_hit' ? e.hit.occurrence_id : ''));
  assert.equal(hits.length, 24);
  assert.equal(new Set(hits).size, 24);
  assert.ok(batches.every(b => b.release_id === 'rel-2' && b.guidance_version === 'guidance-test/1'));
  assert.ok(batches.slice(0, -1).every(b => b.continuation && b.remaining));
  assert.equal(batches.at(-1)!.remaining, null);
  for (const key of ['release_id', 'mode', 'depth', 'delivered_scope', 'context_scope', 'evidence', 'citations', 'searched_scope', 'coverage', 'limitations', 'remaining', 'continuation', 'guidance_version'])
    assert.ok(Object.hasOwn(batches[0], key), key);
});

test('after promotion or rollback a continuation resolves current anew and rejects a stale anchor', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 1024, commonCount: 24 });
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
  const fixture = buildFixture({ pageCap: 1024, commonCount: 24 });
  const tamper = [
    { source: B, output: 'syn-src-b', file: 0, page: 0 },        // source outside the workload
    { source: A, output: 'syn-src-1', file: 0, page: 9999 },     // not a candidate page
    { source: A, output: 'syn-src-1', file: 0, page: 0, extra: 1 },
  ];
  for (const pos of tamper) {
    const token = await encodeContinuation(workload, { op: 'search', pos, key: null });
    await assert.rejects(searchBatch(await ReadSession.open(fixture.env, roomy), new PagedIndexSearch(), workload, token, 'g/1'), state('invalid_request'), JSON.stringify(pos));
  }
  // Invented anchors: an unselected or high output name, a mid-output page without an order key,
  // and order keys on a real candidate page that are not postings there (past the end, or in range).
  const directory = JSON.parse(new TextDecoder().decode(fixture.indexes['syn-src-1'].manifest)).files[0].pages as { first_key: string; last_key: string }[];
  const first = directory.findIndex(p => p.first_key <= 'common' && 'common' <= p.last_key);
  const real = fixture.postings['syn-src-1'].filter(p => p.search_key === 'common')[0];
  const forged = [
    { pos: { source: A, output: '../x', file: 0, page: 0 }, key: null },
    { pos: { source: A, output: 'zzz-after-everything', file: 0, page: 0 }, key: null },
    { pos: { source: A, output: 'syn-src-1', file: 0, page: first + 1 }, key: null },
    { pos: { source: A, output: 'syn-src-1', file: 0, page: first }, key: [9_000_000, 'occ-x'] },
    { pos: { source: A, output: 'syn-src-1', file: 0, page: first }, key: [real.native_order, `${real.occurrence_id}-forged`] },
  ];
  for (const { pos, key } of forged) {
    const token = await encodeContinuation(workload, { op: 'search', pos, key });
    await assert.rejects(searchBatch(await ReadSession.open(fixture.env, roomy), new PagedIndexSearch(), workload, token, 'g/1'),
      state('invalid_request'), JSON.stringify(pos));
  }
  assert.equal(SEARCH_CHECKS.search({ source: A, output: 'syn-src-1', file: 0, page: 0 }, [1, 'occ'], workload), true);
  assert.equal(SEARCH_CHECKS.search({ source: A, output: 'syn-src-1', file: 0, page: 0 }, [-1, 'occ'], workload), false);
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
      return { ...base, state: 'unsupported_capability', hits: [], remaining: null,
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
      searched: request.sources.map(s => ({ source_revision_id: s, capability: 'word_exact', coverage_state: 'available', unit_ids: ['u1', 'u2'], normalization_rule: 'syn:identity/1', complete: !rest, resumed_after: request.position?.after ?? null })),
      remaining: rest && last ? { source: last.source_revision_id, output: 'memory', file: 0, page: 0, after: [last.native_order, last.occurrence_id] } : null };
  }
}

test('a contract-faithful replacement adapter yields the same hits through the same batch contract', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 1024, commonCount: 24 });
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
  const fixture = buildFixture({ pageCap: 1024, commonCount: 24 });
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
