import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildFixture, entriesOf, A, B, type Fixture} from './fixture.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {
  limitsFor,
  type BudgetLimits,
} from '../../services/study/src/read/budget.ts';
import {
  PagedIndexSearch,
  clearSearchCache,
  type SearchRequest,
  type SearchResult,
} from '../../services/study/src/read/search.ts';
import {compareUtf8} from '../../services/study/src/read/bytes.ts';
import {QUERIES} from '../../services/study/src/read/queries.ts';
import {ReadError} from '../../services/study/src/read/states.ts';
import {sourcesWith} from '../../services/study/src/operators/language.ts';

const roomy = {
  ...limitsFor({}, 'passage'),
  d1Calls: 10,
  r2Reads: 40,
  r2Bytes: 1 << 20,
  resultBytes: 1 << 20,
};
const adapter = new PagedIndexSearch();
const state = (s: string) => (error: unknown) =>
  error instanceof ReadError && error.state === s;

async function once(
  fixture: Fixture,
  request: SearchRequest,
  limits: BudgetLimits = roomy,
) {
  const session = await ReadSession.open(fixture.env, limits);
  return {
    result: await adapter.search(session, request),
    usage: session.budget.usage(),
  };
}

/** Follows `remaining` across requests, each with a fresh session and allowance. */
async function all(
  fixture: Fixture,
  request: SearchRequest,
  limits: BudgetLimits,
) {
  const results: SearchResult[] = [];
  const usage = [];
  let position = null;
  for (let i = 0; i < 100; i++) {
    const step = await once(fixture, {...request, position}, limits);
    results.push(step.result);
    usage.push(step.usage);
    position = step.result.remaining;
    if (!position) break;
  }
  return {results, usage, hits: results.flatMap(r => r.hits)};
}

const expected = (fixture: Fixture, outputs: string[], key: string) =>
  outputs.flatMap(o =>
    fixture.postings[o]
      .filter(p => p.search_key === key)
      .sort(
        (x, y) =>
          x.native_order - y.native_order ||
          compareUtf8(x.occurrence_id, y.occurrence_id),
      )
      .map(p => p.occurrence_id),
  );

test('UTF-8 byte order differs from JavaScript order above U+FFFF', () => {
  assert.ok('\u{10900}' < 'ﬀ');
  assert.ok(compareUtf8('\u{10900}', 'ﬀ') > 0);
  assert.equal(compareUtf8('a', 'ab') < 0, true);
});

test('exact word search returns attributed native references across partitions in deterministic order', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const {result} = await once(fixture, {
    lookup: 'word',
    key: 'alpha',
    sources: [A],
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.ranked, false);
  assert.deepEqual(
    result.hits.map(h => h.occurrence_id),
    expected(fixture, ['syn-src-1', 'syn-src-2'], 'alpha'),
  );
  assert.ok(
    result.hits.every(
      h =>
        h.source_revision_id === A && h.native_reference.segments.length === 1,
    ),
  );
  assert.deepEqual(
    result.searched.map(s => [
      s.first_unit,
      s.last_unit,
      s.unit_count,
      s.order_range,
      s.complete,
      s.coverage_state,
    ]),
    [
      ['u1', 'u1', 1, [0, 9999], true, 'available'],
      ['u2', 'u2', 1, [10000, 19999], true, 'available'],
    ],
  );
  assert.equal(result.resume_after.length, result.hits.length);
  assert.equal(
    JSON.stringify(result).includes('synthetic/indexes'),
    false,
    'object keys never reach results',
  );
});

function routeFixture(fixture: Fixture, outputs: string[]) {
  // Fixtures select a release first, whereas Preparation creates routes before selection.
  fixture.db.sqlite.exec('DROP TRIGGER index_routes_insert_selected');
  for (const output of outputs) {
    const keys = [...new Set(fixture.postings[output].map(p => p.search_key))];
    fixture.db.sqlite
      .prepare('INSERT INTO index_routes (output_id, keys_json) VALUES (?, ?)')
      .run(output, JSON.stringify(keys));
  }
  storeSummary(fixture);
}

/** Store the release summary as selecting the release does, from the routes now present. */
function storeSummary(fixture: Fixture) {
  fixture.db.sqlite.exec(
    'DELETE FROM release_index_summary; UPDATE release_selection SET current_release_id = current_release_id',
  );
}

/** Make the release look older than the summary: Study then keeps the full scan. */
function dropSummary(fixture: Fixture) {
  fixture.db.sqlite.exec('DELETE FROM release_index_summary');
}

test('index route access path uses the search-key primary index', () => {
  const fixture = buildFixture();
  const params = QUERIES.index_files.params({
    source_revision_ids: [A],
    capability: 'word_exact',
    key: 'lemma:prov-a:lemma-alpha',
  });
  const plan = fixture.db.sqlite
    .prepare(`EXPLAIN QUERY PLAN ${QUERIES.index_files.sql}`)
    .all('rel-2', ...(params as Array<string | number | null>), 41);
  const detail = plan.map(row => String(row.detail)).join('\n');
  assert.match(
    detail,
    /SEARCH rk USING PRIMARY KEY \(search_key=\? AND output_key=\?\)/,
  );
  const verifyPlan = fixture.db.sqlite
    .prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM index_route_key_records WHERE output_id = ? ORDER BY output_id LIMIT 500 OFFSET 0',
    )
    .all('syn-src-1');
  const verifyDetail = verifyPlan.map(row => String(row.detail)).join('\n');
  assert.match(
    verifyDetail,
    /SEARCH k USING PRIMARY KEY \(search_key=\? AND output_key=\?\)/,
  );
  assert.doesNotMatch(verifyDetail, /SCAN k\b/);
});

/** Routes are derived from the postings; old outputs without routes remain searchable. */
test('indexed output routing skips empty partitions without losing occurrences', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const request: SearchRequest = {lookup: 'word', key: 'epsilon', sources: [A]};
  const baseline = await once(fixture, request);
  assert.equal(baseline.result.state, 'complete');
  assert.equal(
    baseline.result.searched.filter(s => !s.routing_summary).length,
    2,
  );
  routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
  // A new binding observes the newly prepared immutable routing; the per-binding
  // D1 result cache must not reuse a pre-route query from the same fixture.
  fixture.env.DATA_DB = {...fixture.db};
  clearSearchCache();
  const routed = await once(fixture, request);
  assert.equal(routed.result.state, 'complete');
  assert.deepEqual(
    routed.result.hits.map(h => h.occurrence_id),
    baseline.result.hits.map(h => h.occurrence_id),
  );
  assert.equal(
    routed.result.searched.filter(s => !s.routing_summary).length,
    1,
  );
  const skipped = routed.result.searched.filter(s => s.routing_summary);
  assert.deepEqual(
    skipped.map(s => [s.first_unit, s.last_unit, s.order_range]),
    [['u1', 'u1', [0, 9999]]],
  );
  assert.ok(
    routed.usage.r2Reads < baseline.usage.r2Reads,
    'the irrelevant partition is never opened',
  );
});

test('a routed no-match output retains coverage beside a legacy matching output', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const request: SearchRequest = {lookup: 'word', key: 'epsilon', sources: [A]};
  const baseline = await once(fixture, request);
  routeFixture(fixture, ['syn-src-1']);
  fixture.env.DATA_DB = {...fixture.db};
  clearSearchCache();
  const mixed = await once(fixture, request);
  assert.equal(mixed.result.state, 'complete');
  assert.deepEqual(mixed.result.hits, baseline.result.hits);
  assert.deepEqual(
    mixed.result.searched
      .filter(s => s.routing_summary)
      .map(s => s.order_range),
    [[0, 9999]],
  );
  assert.equal(mixed.usage.d1Calls, 3);
  assert.ok(mixed.usage.r2Reads < baseline.usage.r2Reads);
});

test('a key absent from complete routed indexes is no_match, not missing coverage', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
  const {result, usage} = await once(fixture, {
    lookup: 'word',
    key: 'unlisted',
    sources: [A],
  });
  assert.equal(result.state, 'no_match');
  assert.equal(result.limitations.length, 0);
  assert.equal(result.hits.length, 0);
  assert.ok(result.searched.some(s => s.routing_summary && s.unit_count > 0));
  assert.equal(usage.r2Reads, 0);
});

test('routed coverage is retained when matching outputs span two D1 pages', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
  const db = fixture.db.sqlite;
  // Extend only this synthetic fixture, as if built before selection.
  db.exec('DROP TRIGGER release_membership_insert_selected');
  db.exec(`INSERT INTO prepared_outputs
    SELECT 'syn-src-skipped', kind, input_revisions_json, method_version,
      parameters_json, native_extent_json, validation_basis_json
    FROM prepared_outputs WHERE id = 'syn-src-1'`);
  db.exec(`INSERT INTO coverage
    (output_id, source_revision_id, native_extent_json, capability, state,
     method_version, index_artifact_id, dependencies_json, limitation)
    SELECT 'syn-src-skipped', source_revision_id,
      '{"unit_ids":["u3"],"order_range":[20000,29999]}', capability,
      state, method_version, NULL, dependencies_json, limitation
    FROM coverage WHERE output_id = 'syn-src-1'`);
  const insertRoute = db.prepare(
    'INSERT INTO index_routes (output_id, keys_json) VALUES (?, ?)',
  );
  insertRoute.run('syn-src-skipped', '["not-alpha"]');
  db.exec(`INSERT INTO release_outputs (release_id, output_id)
    VALUES ('rel-2', 'syn-src-skipped')`);
  storeSummary(fixture);
  const run = await all(
    fixture,
    {lookup: 'word', key: 'alpha', sources: [A]},
    {...roomy, rowsPerQuery: 4},
  );
  assert.ok(run.results.length > 1);
  assert.deepEqual(
    run.hits.map(h => h.occurrence_id),
    expected(fixture, ['syn-src-1', 'syn-src-2'], 'alpha'),
  );
  assert.deepEqual(
    run.results.flatMap(r =>
      r.searched.filter(s => s.routing_summary).map(s => s.order_range),
    ),
    [[20000, 29999]],
  );
});

test('routing keeps incompatible matching and nonmatching outputs as limitations', async () => {
  for (const output of ['syn-src-1', 'syn-src-2']) {
    clearSearchCache();
    const fixture = buildFixture();
    routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
    fixture.db.sqlite.exec('DROP TRIGGER coverage_immutable');
    fixture.db.sqlite
      .prepare(
        `UPDATE coverage
        SET native_extent_json = json_remove(native_extent_json, '$.order_range')
        WHERE output_id = ?`,
      )
      .run(output);
    storeSummary(fixture);
    const {result} = await once(fixture, {
      lookup: 'word',
      key: 'epsilon',
      sources: [A],
    });
    assert.equal(result.state, 'incomplete');
    assert.ok(result.limitations.some(l => l.state === 'incompatible_index'));
    assert.equal(
      result.searched.some(s => s.routing_summary),
      output === 'syn-src-2',
    );
  }
});

test('cold ordinary and absent-key search measure the cost of routed coverage', async () => {
  for (const key of ['alpha', 'unlisted']) {
    clearSearchCache();
    const fixture = buildFixture();
    const request: SearchRequest = {lookup: 'word', key, sources: [A]};
    const args = ['rel-2', JSON.stringify([A]), 'word_exact', key] as const;
    const files = fixture.db.sqlite.prepare(QUERIES.index_files.sql);
    assert.equal(files.all(...args, A, -1, '', 41).length, 6);
    const before = await once(fixture, request);
    routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
    fixture.env.DATA_DB = {...fixture.db};
    clearSearchCache();
    const after = await once(fixture, request);
    assert.equal(before.usage.d1Calls, 2);
    assert.equal(after.usage.d1Calls, 3);
    assert.equal(
      files.all(...args, A, -1, '', 41).length,
      key === 'alpha' ? 6 : 0,
    );
    const coverageRows = fixture.db.sqlite
      .prepare(QUERIES.index_sources.sql)
      .all(...args, 41);
    assert.equal(coverageRows.length, 1);
    assert.deepEqual(after.result.hits, before.result.hits);
    assert.equal(after.result.state, before.result.state);
    if (key === 'unlisted') assert.equal(after.usage.r2Reads, 0);
  }
});

test('exact search can use cached index metadata after its D1 allowance is spent', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const request: SearchRequest = {lookup: 'word', key: 'alpha', sources: [A]};
  const cold = await once(fixture, request);
  assert.equal(cold.usage.d1Calls, 2);
  assert.ok(cold.result.hits.length > 0);

  const warm = await once(fixture, request, {...roomy, d1Calls: 1});
  assert.deepEqual(warm.result, cold.result);
  assert.equal(warm.usage.d1Calls, 1);
});

test('a key spanning many pages is enumerated across bounded requests without duplicates or false exhaustion', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048, commonCount: 48});
  const run = await all(
    fixture,
    {lookup: 'word', key: 'common', sources: [A]},
    limitsFor({}, 'passage'),
  );
  const want = expected(fixture, ['syn-src-1'], 'common');
  assert.equal(want.length, 48);
  assert.deepEqual(
    run.hits.map(h => h.occurrence_id),
    want,
  );
  assert.ok(run.results.length > 2, 'the key spans several requests');
  assert.ok(
    run.results.slice(0, -1).every(r => r.state === 'continues' && r.remaining),
    'no request before the last claims exhaustion',
  );
  assert.equal(run.results.at(-1)!.state, 'complete');
  assert.ok(
    run.results.every(r => r.state !== 'no_match'),
    'a resumed search that ends without new hits is complete, not no_match',
  );
  for (const u of run.usage) {
    assert.ok(
      u.d1Calls <= 2 &&
        u.r2Reads <= 4 &&
        u.r2Bytes <= limitsFor({}, 'passage').r2Bytes,
      JSON.stringify(u),
    );
  }
  assert.equal(run.usage[0].r2Reads, 4);
  assert.ok(
    run.usage.slice(1, -1).every(u => u.r2Reads === 4),
    'later requests reuse the verified manifest and read only pages',
  );
});

test('the same enumeration works with a cold cache on every request', async () => {
  const fixture = buildFixture({pageCap: 2048, commonCount: 48});
  const hits = [];
  let position = null;
  for (let i = 0; i < 100; i++) {
    clearSearchCache();
    const {result} = await once(
      fixture,
      {lookup: 'word', key: 'common', sources: [A], position},
      limitsFor({}, 'passage'),
    );
    hits.push(...result.hits);
    position = result.remaining;
    if (!position) break;
  }
  assert.deepEqual(
    hits.map(h => h.occurrence_id),
    expected(fixture, ['syn-src-1'], 'common'),
  );
});

test('keys above U+FFFF select the right pages', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 3200}); // this cap puts both keys on one page
  const pages = entriesOf(fixture.indexes['syn-src-1']);
  assert.ok(
    pages.some(p => p.first_key === '\uFB00' && p.last_key === '\u{10900}'),
    'one page spans both keys, which UTF-16 comparison would misorder',
  );
  for (const key of ['\u{10900}', 'ﬀ']) {
    const {result} = await once(fixture, {lookup: 'word', key, sources: [A]});
    assert.deepEqual(
      result.hits.map(h => h.occurrence_id),
      expected(fixture, ['syn-src-1'], key),
      key,
    );
  }
});

test('lemma, form and grammar lookups keep competing analyses separate and attributed', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const form = (
    await once(fixture, {lookup: 'form', key: 'alpha', sources: [A]})
  ).result;
  assert.equal(form.hits.length, 6);
  const providers = (form.hits[0].analyses as {provider: string}[]).map(
    a => a.provider,
  );
  assert.deepEqual(providers, ['syn-provider-a', 'syn-provider-b']);
  assert.equal(
    (
      await once(fixture, {
        lookup: 'lemma',
        key: 'prov-b:lemma-gamma',
        sources: [A],
      })
    ).result.hits.length,
    1,
  );
  assert.equal(
    (await once(fixture, {lookup: 'grammar', key: 'verb', sources: [A]})).result
      .hits.length,
    11,
    'every token of u1 and u2',
  );
});

test('phrase, proximity and fuzzy are explicit unsupported capabilities, not empty searches', async () => {
  const fixture = buildFixture();
  for (const lookup of ['phrase', 'proximity', 'fuzzy']) {
    const {result, usage} = await once(fixture, {
      lookup,
      key: 'alpha beta',
      sources: [A],
    });
    assert.equal(result.state, 'unsupported_capability');
    assert.deepEqual(
      result.limitations.map(l => l.state),
      ['unsupported_capability'],
    );
    assert.deepEqual(
      [usage.d1Calls, usage.r2Reads],
      [1, 0],
      'nothing beyond the current-release read',
    );
  }
  await assert.rejects(
    once(fixture, {lookup: 'regex', key: '.*', sources: [A]}),
    state('invalid_request'),
  );
});

test('no match, missing index and partial coverage are distinct', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  const none = (
    await once(fixture, {lookup: 'word', key: 'nothing', sources: [A]})
  ).result;
  assert.equal(none.state, 'no_match');
  assert.ok(none.searched.every(s => s.complete));
  const lemmaB = (
    await once(fixture, {lookup: 'lemma', key: 'x', sources: [A, B]})
  ).result;
  assert.equal(lemmaB.state, 'incomplete');
  assert.deepEqual(
    lemmaB.limitations.map(l => [l.scope, l.state]),
    [[B, 'missing_index']],
  );
  const partial = (
    await once(fixture, {lookup: 'word', key: 'alpha', sources: [B]})
  ).result;
  assert.equal(partial.hits.length, 1);
  assert.deepEqual(
    partial.limitations.map(l => [l.state, l.detail]),
    [['missing_index', 'synthetic partial extent']],
  );
});

test('older-release indexes are not searched; the same key appears when that release is current', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  assert.equal(
    (await once(fixture, {lookup: 'word', key: 'onlyold', sources: [A]})).result
      .state,
    'no_match',
  );
  fixture.select('rel-1', null);
  const old = (
    await once(fixture, {lookup: 'word', key: 'onlyold', sources: [A]})
  ).result;
  assert.deepEqual(
    old.hits.map(h => h.span_id),
    ['a-old'],
  );
});

test('a corrupt page withholds that output while other outputs keep their results', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.bucket.corrupt.add('synthetic/indexes/syn-src-1/postings');
  const {result} = await once(fixture, {
    lookup: 'word',
    key: 'alpha',
    sources: [A],
  });
  assert.equal(result.state, 'incomplete');
  assert.deepEqual(
    result.hits.map(h => h.span_id),
    ['a-u2', 'a-u2'],
  );
  assert.deepEqual(
    result.limitations.map(l => l.state),
    ['corrupt'],
  );
  assert.deepEqual(
    result.searched.map(s => s.complete),
    [false, true],
  );
});

test('a manifest that disagrees with its D1 coverage or registration is withheld', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.db.sqlite.exec('DROP TRIGGER coverage_immutable');
  fixture.db.sqlite.exec(
    `UPDATE coverage SET state = 'partial', limitation = 'x' WHERE output_id = 'syn-src-2'`,
  );
  storeSummary(fixture);
  const {result} = await once(fixture, {
    lookup: 'word',
    key: 'alpha',
    sources: [A],
  });
  assert.deepEqual(
    result.limitations.map(l => [l.state, l.detail]),
    [['corrupt', 'Index manifest: coverage disagrees with the D1 record']],
  );
  assert.equal(result.hits.length, 4);
});

test('a provider failure is temporary and leaves other outputs readable', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  fixture.bucket.failing.add('synthetic/indexes/syn-src-2/manifest');
  const {result} = await once(fixture, {
    lookup: 'word',
    key: 'alpha',
    sources: [A],
  });
  assert.deepEqual(
    result.limitations.map(l => l.state),
    ['temporary_failure'],
  );
  assert.equal(result.hits.length, 4);
});

test('malformed or mismatched positions are rejected before reading pages', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048});
  const bad = [
    {
      source: B,
      output: 'syn-src-1',
      order: 0,
      dir: 0,
      entry: 0,
      after: null,
      anchor: null,
    }, // source not requested
    {
      source: A,
      output: 'syn-src-1',
      order: 0,
      dir: 999,
      entry: 0,
      after: [0, 'x'] as [number, string],
      anchor: {
        file: 'syn-src-1:postings',
        offset: 0,
        length: 10,
        sha256: '0'.repeat(64),
      },
    }, // not a candidate directory page
    {
      source: A,
      output: '',
      order: 0,
      dir: 3,
      entry: 0,
      after: null,
      anchor: null,
    }, // start position with a page
    {
      source: A,
      output: 'syn-src-1',
      order: 0,
      dir: -1,
      entry: 0,
      after: null,
      anchor: null,
    },
    {
      source: A,
      output: 'syn-src-1',
      order: 0,
      dir: 0,
      entry: 0,
      after: [0, 'x'] as [number, string],
      anchor: null,
    }, // key without anchor
  ];
  for (const position of bad)
    await assert.rejects(
      once(fixture, {lookup: 'word', key: 'common', sources: [A], position}),
      state('invalid_request'),
      JSON.stringify(position),
    );
  assert.equal(
    fixture.bucket.reads.filter(r => r.offset !== undefined).length,
    0,
  );
});

test('a page or manifest beyond the configured caps is reported, not read', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048});
  const {result} = await once(
    fixture,
    {lookup: 'word', key: 'alpha', sources: [A]},
    {...roomy, pageBytes: 1024},
  );
  assert.deepEqual(
    result.limitations.map(l => l.state),
    ['exceeds_limits', 'exceeds_limits'],
  );
  clearSearchCache();
  const small = await once(
    fixture,
    {lookup: 'word', key: 'alpha', sources: [A]},
    {...roomy, r2Bytes: 800},
  );
  assert.ok(small.result.limitations.every(l => l.state === 'exceeds_limits'));
  assert.equal(small.usage.r2Reads, 0);
});

test('local measurement: queries, rows, R2 reads and bytes per request (synthetic, Node, not Workers)', async t => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048, commonCount: 60});
  const started = performance.now();
  const run = await all(
    fixture,
    {lookup: 'word', key: 'common', sources: [A]},
    limitsFor({}, 'passage'),
  );
  const elapsed = performance.now() - started;
  t.diagnostic(
    `common key: ${run.hits.length} occurrences in ${run.results.length} requests, ${(elapsed / run.results.length).toFixed(2)} ms/request in-process`,
  );
  for (const [i, u] of run.usage.entries())
    t.diagnostic(
      `request ${i + 1}: D1 ${u.d1Calls} calls, R2 ${u.r2Reads} reads / ${u.r2Bytes} B, result ${u.resultBytes} B, hits ${run.results[i].hits.length}`,
    );
  assert.equal(run.hits.length, 60);
});

test('R30-8: one output filling the whole D1 window is reported, not repeated as the same continuation', async () => {
  clearSearchCache();
  const fixture = buildFixture();
  await assert.rejects(
    once(
      fixture,
      {lookup: 'word', key: 'alpha', sources: [A]},
      {...roomy, rowsPerQuery: 2},
    ),
    state('exceeds_limits'),
  );
});

/** The stored summary must answer both routing questions exactly as the full scan does. */
test("the stored index summary gives the full scan's files and coverage, without scanning coverage", () => {
  const fixture = buildFixture();
  routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
  const db = fixture.db.sqlite;
  assert.ok(
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM release_index_summary WHERE release_id = ?',
      )
      .get('rel-2')!.n,
  );
  for (const key of ['alpha', 'unlisted']) {
    const args = ['rel-2', JSON.stringify([A]), 'word_exact', key] as const;
    const scan = db
      .prepare(QUERIES.index_files.sql)
      .all(...args, A, -1, '', 41);
    const stored = db
      .prepare(QUERIES.index_files_summary.sql)
      .all(...args, A, -1, '', 41);
    assert.deepEqual(stored, scan, key);
    const extents = (rows: unknown[]) =>
      rows.map(row => {
        const r = row as {source_revision_id: string; extents: string};
        return [
          r.source_revision_id,
          JSON.parse(r.extents)
            .map((e: unknown) => JSON.stringify(e))
            .sort(),
        ];
      });
    assert.deepEqual(
      extents(db.prepare(QUERIES.index_sources_summary.sql).all(...args, 41)),
      extents(db.prepare(QUERIES.index_sources.sql).all(...args, 41)),
      key,
    );
  }
  for (const name of [
    'index_files_summary',
    'index_sources_summary',
  ] as const) {
    const values = name === 'index_files_summary' ? [A, -1, '', 41] : [41];
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${QUERIES[name].sql}`)
      .all('rel-2', JSON.stringify([A]), 'word_exact', 'alpha', ...values)
      .map(row => String(row.detail))
      .join('\n');
    assert.match(plan, /SEARCH s USING PRIMARY KEY/, name);
    assert.doesNotMatch(
      plan,
      /\b(coverage|release_outputs|prepared_outputs|index_routes)\b/,
      name,
    );
  }
});

test('a release stores its summary when it is selected, for the current and the previous release', () => {
  const fixture = buildFixture();
  const db = fixture.db.sqlite;
  const stored = () =>
    db
      .prepare(
        'SELECT release_id, COUNT(*) AS n FROM release_index_summary GROUP BY release_id ORDER BY release_id',
      )
      .all();
  const releases = stored().map(row => row.release_id);
  assert.ok(releases.includes('rel-2'));
  dropSummary(fixture);
  assert.deepEqual(stored(), []);
  storeSummary(fixture);
  assert.deepEqual(
    stored().map(row => row.release_id),
    releases,
  );
});

/** The source list of a search is the same from the stored summary and from the coverage scan. */
test('the sources a search covers are the same from the summary and from the scan, and the summary reads no coverage', async () => {
  const fixture = buildFixture();
  routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
  // One source has no available output left for the capability; the other keeps one.
  const db = fixture.db.sqlite;
  for (const {name} of db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coverage'",
    )
    .all())
    db.exec(`DROP TRIGGER ${name}`);
  db.exec(
    `UPDATE coverage SET state = 'partial', limitation = 'x' WHERE output_id = 'syn-src-2'`,
  );
  // A capability outside the search indexes, which the summary does not hold.
  const columns = db
    .prepare('PRAGMA table_info(coverage)')
    .all()
    .map(column => String(column.name));
  db.exec(
    `INSERT INTO coverage (${columns.join(', ')})
     SELECT ${columns.map(c => (c === 'capability' ? "'source_context'" : c)).join(', ')}
     FROM coverage WHERE output_id = 'syn-src-1' AND capability = 'word_exact'`,
  );
  storeSummary(fixture);
  const listed = (name: 'release_sources' | 'release_sources_summary') =>
    db
      .prepare(QUERIES[name].sql)
      .all('rel-2', 'word_exact', '', '', 41)
      .map(row => [
        row.source_revision_id,
        row.capability,
        row.outputs,
        Number(row.available) > 0,
      ]);
  assert.deepEqual(
    listed('release_sources_summary'),
    listed('release_sources'),
  );
  assert.ok(listed('release_sources_summary').length > 0);
  const allCapabilities = (
    name: 'release_sources' | 'release_sources_summary',
  ) =>
    db
      .prepare(QUERIES[name].sql)
      .all('rel-2', null, '', '', 41)
      .map(row => [
        row.source_revision_id,
        row.capability,
        Number(row.available) > 0,
      ]);
  assert.deepEqual(
    allCapabilities('release_sources_summary'),
    allCapabilities('release_sources'),
  );
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${QUERIES.release_sources_summary.sql}`)
    .all('rel-2', 'word_exact', '', '', 41)
    .map(row => String(row.detail))
    .join('\n');
  assert.match(plan, /SEARCH s USING PRIMARY KEY/);
  assert.doesNotMatch(
    plan,
    /\b(coverage|release_outputs|prepared_outputs|index_routes|source_nodes)\b/,
  );
  const other: string[][] = [];
  for (const summary of [true, false]) {
    if (!summary) dropSummary(fixture);
    const session = await ReadSession.open(fixture.env, roomy);
    assert.equal(session.release.index_summary, summary);
    assert.deepEqual(
      await sourcesWith(session, 'word_exact'),
      [A],
      summary ? 'summary' : 'scan',
    );
    // A capability that is not a search capability is not in the summary: it keeps the scan.
    other.push(await sourcesWith(session, 'source_context'));
  }
  assert.ok(other[0].length > 0, 'the fixture has source_context');
  assert.deepEqual(other[0], other[1]);
});

/** Exhausting a key page by page returns the same answer by both paths, at a tight allowance. */
test('a search that is followed to its end returns the same answer from the summary and from the scan', async () => {
  const tight = {...roomy, rowsPerQuery: 4};
  for (const key of ['alpha', 'unlisted']) {
    const request: SearchRequest = {lookup: 'word', key, sources: [A, B]};
    const results = [];
    for (const summary of [true, false]) {
      clearSearchCache();
      const fixture = buildFixture();
      routeFixture(fixture, ['syn-src-1', 'syn-src-2']);
      if (!summary) dropSummary(fixture);
      assert.equal(
        (await ReadSession.open(fixture.env, roomy)).release.index_summary,
        summary,
      );
      const followed = await all(fixture, request, tight);
      assert.equal(followed.results.at(-1)!.remaining, null, 'exhausted');
      results.push(followed);
    }
    const [stored, scanned] = results;
    assert.ok(stored.results.length > 1 || key === 'unlisted', 'continued');
    assert.deepEqual(stored.results, scanned.results, key);
    assert.deepEqual(
      stored.usage.map(u => u.d1Calls),
      scanned.usage.map(u => u.d1Calls),
      key,
    );
  }
});
