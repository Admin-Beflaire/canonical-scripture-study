import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, entriesOf, A, B, type Fixture } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { STARTING_LIMITS, type BudgetLimits } from '../../services/study/src/read/budget.ts';
import { PagedIndexSearch, clearSearchCache, type SearchRequest, type SearchResult } from '../../services/study/src/read/search.ts';
import { compareUtf8 } from '../../services/study/src/read/bytes.ts';
import { ReadError } from '../../services/study/src/read/states.ts';

const roomy = { ...STARTING_LIMITS, d1Calls: 10, r2Reads: 40, r2Bytes: 1 << 20, resultBytes: 1 << 20 };
const adapter = new PagedIndexSearch();
const state = (s: string) => (error: unknown) => error instanceof ReadError && error.state === s;

async function once(fixture: Fixture, request: SearchRequest, limits: BudgetLimits = roomy) {
  const session = await ReadSession.open(fixture.env, limits);
  return { result: await adapter.search(session, request), usage: session.budget.usage() };
}

/** Follows `remaining` across requests, each with a fresh session and allowance. */
async function all(fixture: Fixture, request: SearchRequest, limits: BudgetLimits) {
  const results: SearchResult[] = [];
  const usage = [];
  let position = null;
  for (let i = 0; i < 100; i++) {
    const step = await once(fixture, { ...request, position }, limits);
    results.push(step.result); usage.push(step.usage);
    position = step.result.remaining;
    if (!position) break;
  }
  return { results, usage, hits: results.flatMap(r => r.hits) };
}

const expected = (fixture: Fixture, outputs: string[], key: string) =>
  outputs.flatMap(o => fixture.postings[o].filter(p => p.search_key === key)
    .sort((x, y) => x.native_order - y.native_order || compareUtf8(x.occurrence_id, y.occurrence_id)).map(p => p.occurrence_id));

test('UTF-8 byte order differs from JavaScript order above U+FFFF', () => {
  assert.ok('\u{10900}' < 'ﬀ');
  assert.ok(compareUtf8('\u{10900}', 'ﬀ') > 0);
  assert.equal(compareUtf8('a', 'ab') < 0, true);
});

test('exact word search returns attributed native references across partitions in deterministic order', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const { result } = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] });
  assert.equal(result.state, 'complete');
  assert.equal(result.ranked, false);
  assert.deepEqual(result.hits.map(h => h.occurrence_id), expected(fixture, ['syn-src-1', 'syn-src-2'], 'alpha'));
  assert.ok(result.hits.every(h => h.source_revision_id === A && h.native_reference.segments.length === 1));
  assert.deepEqual(result.searched.map(s => [s.unit_ids, s.complete, s.coverage_state]), [[['u1'], true, 'available'], [['u2'], true, 'available']]);
  assert.equal(JSON.stringify(result).includes('synthetic/indexes'), false, 'object keys never reach results');
});

test('a key spanning many pages is enumerated across bounded requests without duplicates or false exhaustion', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const run = await all(fixture, { lookup: 'word', key: 'common', sources: [A] }, STARTING_LIMITS);
  const want = expected(fixture, ['syn-src-1'], 'common');
  assert.equal(want.length, 48);
  assert.deepEqual(run.hits.map(h => h.occurrence_id), want);
  assert.ok(run.results.length > 2, 'the key spans several requests');
  assert.ok(run.results.slice(0, -1).every(r => r.state === 'continues' && r.remaining), 'no request before the last claims exhaustion');
  assert.equal(run.results.at(-1)!.state, 'complete');
  assert.ok(run.results.every(r => r.state !== 'no_match'), 'a resumed search that ends without new hits is complete, not no_match');
  for (const u of run.usage) {
    assert.ok(u.d1Calls <= 2 && u.r2Reads <= 4 && u.r2Bytes <= STARTING_LIMITS.r2Bytes, JSON.stringify(u));
  }
  assert.equal(run.usage[0].r2Reads, 4);
  assert.ok(run.usage.slice(1, -1).every(u => u.r2Reads === 4), 'later requests reuse the verified manifest and read only pages');
});

test('the same enumeration works with a cold cache on every request', async () => {
  const fixture = buildFixture({ pageCap: 2048, commonCount: 48 });
  const hits = [];
  let position = null;
  for (let i = 0; i < 100; i++) {
    clearSearchCache();
    const { result } = await once(fixture, { lookup: 'word', key: 'common', sources: [A], position }, STARTING_LIMITS);
    hits.push(...result.hits);
    position = result.remaining;
    if (!position) break;
  }
  assert.deepEqual(hits.map(h => h.occurrence_id), expected(fixture, ['syn-src-1'], 'common'));
});

test('keys above U+FFFF select the right pages', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 3200 });   // this cap puts both keys on one page
  const pages = entriesOf(fixture.indexes['syn-src-1']);
  assert.ok(pages.some(p => p.first_key === '\uFB00' && p.last_key === '\u{10900}'),
    'one page spans both keys, which UTF-16 comparison would misorder');
  for (const key of ['\u{10900}', 'ﬀ']) {
    const { result } = await once(fixture, { lookup: 'word', key, sources: [A] });
    assert.deepEqual(result.hits.map(h => h.occurrence_id), expected(fixture, ['syn-src-1'], key), key);
  }
});

test('lemma, form and grammar lookups keep competing analyses separate and attributed', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const form = (await once(fixture, { lookup: 'form', key: 'alpha', sources: [A] })).result;
  assert.equal(form.hits.length, 6);
  const providers = (form.hits[0].analyses as { provider: string }[]).map(a => a.provider);
  assert.deepEqual(providers, ['syn-provider-a', 'syn-provider-b']);
  assert.equal((await once(fixture, { lookup: 'lemma', key: 'prov-b:lemma-gamma', sources: [A] })).result.hits.length, 1);
  assert.equal((await once(fixture, { lookup: 'grammar', key: 'verb', sources: [A] })).result.hits.length, 11, 'every token of u1 and u2');
});

test('phrase, proximity and fuzzy are explicit unsupported capabilities, not empty searches', async () => {
  const fixture = buildFixture();
  for (const lookup of ['phrase', 'proximity', 'fuzzy']) {
    const { result, usage } = await once(fixture, { lookup, key: 'alpha beta', sources: [A] });
    assert.equal(result.state, 'unsupported_capability');
    assert.deepEqual(result.limitations.map(l => l.state), ['unsupported_capability']);
    assert.deepEqual([usage.d1Calls, usage.r2Reads], [1, 0], 'nothing beyond the current-release read');
  }
  await assert.rejects(once(fixture, { lookup: 'regex', key: '.*', sources: [A] }), state('invalid_request'));
});

test('no match, missing index and partial coverage are distinct', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const none = (await once(fixture, { lookup: 'word', key: 'nothing', sources: [A] })).result;
  assert.equal(none.state, 'no_match');
  assert.ok(none.searched.every(s => s.complete));
  const lemmaB = (await once(fixture, { lookup: 'lemma', key: 'x', sources: [A, B] })).result;
  assert.equal(lemmaB.state, 'incomplete');
  assert.deepEqual(lemmaB.limitations.map(l => [l.scope, l.state]), [[B, 'missing_index']]);
  const partial = (await once(fixture, { lookup: 'word', key: 'alpha', sources: [B] })).result;
  assert.equal(partial.hits.length, 1);
  assert.deepEqual(partial.limitations.map(l => [l.state, l.detail]), [['missing_index', 'synthetic partial extent']]);
});

test('older-release indexes are not searched; the same key appears when that release is current', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  assert.equal((await once(fixture, { lookup: 'word', key: 'onlyold', sources: [A] })).result.state, 'no_match');
  fixture.select('rel-1', null);
  const old = (await once(fixture, { lookup: 'word', key: 'onlyold', sources: [A] })).result;
  assert.deepEqual(old.hits.map(h => h.span_id), ['a-old']);
});

test('a corrupt page withholds that output while other outputs keep their results', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.bucket.corrupt.add('synthetic/indexes/syn-src-1/postings');
  const { result } = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] });
  assert.equal(result.state, 'incomplete');
  assert.deepEqual(result.hits.map(h => h.span_id), ['a-u2', 'a-u2']);
  assert.deepEqual(result.limitations.map(l => l.state), ['corrupt']);
  assert.deepEqual(result.searched.map(s => s.complete), [false, true]);
});

test('a manifest that disagrees with its D1 coverage or registration is withheld', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.db.sqlite.exec('DROP TRIGGER coverage_immutable');
  fixture.db.sqlite.exec(`UPDATE coverage SET state = 'partial', limitation = 'x' WHERE output_id = 'syn-src-2'`);
  const { result } = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] });
  assert.deepEqual(result.limitations.map(l => [l.state, l.detail]), [['corrupt', 'Index manifest: coverage disagrees with the D1 record']]);
  assert.equal(result.hits.length, 4);
});

test('a provider failure is temporary and leaves other outputs readable', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.bucket.failing.add('synthetic/indexes/syn-src-2/manifest');
  const { result } = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] });
  assert.deepEqual(result.limitations.map(l => l.state), ['temporary_failure']);
  assert.equal(result.hits.length, 4);
});

test('malformed or mismatched positions are rejected before reading pages', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048 });
  const bad = [
    { source: B, output: 'syn-src-1', order: 0, dir: 0, entry: 0, after: null, anchor: null },             // source not requested
    { source: A, output: 'syn-src-1', order: 0, dir: 999, entry: 0, after: [0, 'x'] as [number, string],
      anchor: { file: 'syn-src-1:postings', offset: 0, length: 10, sha256: '0'.repeat(64) } },                 // not a candidate directory page
    { source: A, output: '', order: 0, dir: 3, entry: 0, after: null, anchor: null },                        // start position with a page
    { source: A, output: 'syn-src-1', order: 0, dir: -1, entry: 0, after: null, anchor: null },
    { source: A, output: 'syn-src-1', order: 0, dir: 0, entry: 0, after: [0, 'x'] as [number, string], anchor: null },  // key without anchor
  ];
  for (const position of bad)
    await assert.rejects(once(fixture, { lookup: 'word', key: 'common', sources: [A], position }), state('invalid_request'), JSON.stringify(position));
  assert.equal(fixture.bucket.reads.filter(r => r.offset !== undefined).length, 0);
});

test('a page or manifest beyond the configured caps is reported, not read', async () => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048 });
  const { result } = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] }, { ...roomy, pageBytes: 1024 });
  assert.deepEqual(result.limitations.map(l => l.state), ['exceeds_limits', 'exceeds_limits']);
  clearSearchCache();
  const small = await once(fixture, { lookup: 'word', key: 'alpha', sources: [A] }, { ...roomy, r2Bytes: 800 });
  assert.ok(small.result.limitations.every(l => l.state === 'exceeds_limits'));
  assert.equal(small.usage.r2Reads, 0);
});

test('local measurement: queries, rows, R2 reads and bytes per request (synthetic, Node, not Workers)', async t => {
  clearSearchCache();
  const fixture = buildFixture({ pageCap: 2048, commonCount: 60 });
  const started = performance.now();
  const run = await all(fixture, { lookup: 'word', key: 'common', sources: [A] }, STARTING_LIMITS);
  const elapsed = performance.now() - started;
  t.diagnostic(`common key: ${run.hits.length} occurrences in ${run.results.length} requests, ${(elapsed / run.results.length).toFixed(2)} ms/request in-process`);
  for (const [i, u] of run.usage.entries())
    t.diagnostic(`request ${i + 1}: D1 ${u.d1Calls} calls, R2 ${u.r2Reads} reads / ${u.r2Bytes} B, result ${u.resultBytes} B, hits ${run.results[i].hits.length}`);
  assert.equal(run.hits.length, 60);
});
