import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildFixture, A, B, type Fixture} from './fixture.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {
  limitsFor,
  RequestBudget,
} from '../../services/study/src/read/budget.ts';
import {readSpans} from '../../services/study/src/read/evidence.ts';
import {
  PagedIndexSearch,
  clearSearchCache,
  type SearchAdapter,
} from '../../services/study/src/read/search.ts';
import {ReadError} from '../../services/study/src/read/states.ts';
import {
  assembleBatch,
  type Batch,
} from '../../services/study/src/results/batch.ts';
import {
  encodeContinuation,
  resumeContinuation,
} from '../../services/study/src/results/continuation.ts';
import {
  searchBatch,
  type SearchWorkload,
} from '../../services/study/src/results/search-batch.ts';

const roomy = {
  ...limitsFor({}, 'passage'),
  d1Calls: 10,
  r2Reads: 40,
  r2Bytes: 1 << 20,
  resultBytes: 1 << 20,
};
const state = (s: string) => (error: unknown) =>
  error instanceof ReadError && error.state === s;
const workload: SearchWorkload = {
  mode: 'word_study',
  depth: 'standard',
  language: 'en',
  lookup: 'word',
  key: 'common',
  sources: [A],
};
const checks = {op: () => true};

async function drain(
  fixture: Fixture,
  adapter: SearchAdapter,
  w: SearchWorkload,
) {
  const batches: Batch[] = [];
  let continuation: string | null = null;
  for (let i = 0; i < 100; i++) {
    const session = await ReadSession.open(
      fixture.env,
      limitsFor({}, 'passage'),
    );
    const batch = await searchBatch(
      session,
      adapter,
      w,
      continuation,
      'guidance-test/1',
    );
    batches.push(batch);
    continuation = batch.continuation;
    if (!continuation) break;
  }
  return batches;
}

test('malformed, foreign or out-of-bounds continuations are rejected', async () => {
  const token = await encodeContinuation(workload, {
    op: 'op',
    pos: {},
    key: null,
  });
  const bad: unknown[] = [
    null,
    42,
    '',
    '***',
    'x'.repeat(5000),
    btoa('{"v":1}'),
    token.slice(0, -4) + 'AAAA',
  ];
  for (const t of bad)
    await assert.rejects(
      resumeContinuation(t, workload, checks),
      state('invalid_request'),
      String(t).slice(0, 20),
    );
  await assert.rejects(
    resumeContinuation(token, {...workload, key: 'other'}, checks),
    state('invalid_request'),
  );
  await assert.rejects(
    resumeContinuation(token, workload, {other: () => true}),
    state('invalid_request'),
  );
  await assert.rejects(
    resumeContinuation(token, workload, {op: () => false}),
    state('invalid_request'),
  );
  await assert.rejects(
    resumeContinuation(
      await encodeContinuation(workload, {
        op: 'constructor',
        pos: {},
        key: null,
      }),
      workload,
      checks,
    ),
    state('invalid_request'),
  );
});

test('after promotion or rollback a continuation resolves current anew and rejects a stale anchor', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048, commonCount: 48});
  const first = await searchBatch(
    await ReadSession.open(fixture.env, limitsFor({}, 'passage')),
    new PagedIndexSearch(),
    workload,
    null,
    'g/1',
  );
  fixture.select('rel-1', 'rel-2'); // the anchored index output is no longer selected
  await assert.rejects(
    searchBatch(
      await ReadSession.open(fixture.env, roomy),
      new PagedIndexSearch(),
      workload,
      first.continuation,
      'g/1',
    ),
    (e: unknown) =>
      e instanceof ReadError &&
      e.state === 'invalid_request' &&
      /start the search again/.test(e.message),
  );
  fixture.select('rel-2', 'rel-1'); // selected again: the same continuation is valid
  const next = await searchBatch(
    await ReadSession.open(fixture.env, limitsFor({}, 'passage')),
    new PagedIndexSearch(),
    workload,
    first.continuation,
    'g/1',
  );
  assert.equal(next.release_id, 'rel-2');
  assert.ok(next.evidence.length > 0);
});

test('citations must match supplied evidence; equal wording from two sources stays separate', async () => {
  const fixture = buildFixture();
  fixture.select(null); // selected outputs are immutable; add the synthetic duplicate before selecting
  fixture.db.sqlite
    .exec(`INSERT INTO native_spans (id, output_id, source_revision_id, parent_id, kind, label, native_order, coordinate_version, segments_json, basis_json, content_id, body_ranges_json, reading_kind)
    SELECT 'b-dup', 'syn-ev-b', '${B}', NULL, 'verse', 'B dup', 1, coordinate_version, segments_json, basis_json, content_id, '[]', 'preserved' FROM native_spans WHERE id = 'a-u1'`);
  fixture.select('rel-2', 'rel-1');
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'b-dup']);
  assert.equal(read.spans.length, 2);
  const [a, b] = read.spans;
  assert.equal(a.text![0], b.text![0]);
  const {batch} = assembleBatch(
    {
      release_id: session.release.id,
      mode: 'passage',
      depth: 'standard',
      delivered_scope: null,
      context_scope: null,
      evidence: read.spans.map(span => ({kind: 'source_text' as const, span})),
      searched_scope: [],
      coverage: [],
      remaining: null,
      continuation: null,
      guidance_version: 'g/1',
      limitations: read.limitations,
      citations: [
        {
          source_revision_id: A,
          span_id: 'a-u1',
          coordinate_version: a.coordinate_version,
          segments: [{unit_id: 'u1', start: 0, end: 5}],
          quote: 'alpha beta',
        },
        {
          source_revision_id: B,
          span_id: 'a-u1',
          coordinate_version: a.coordinate_version,
          segments: a.segments,
        }, // wrong source
        {
          source_revision_id: A,
          span_id: 'a-u1',
          coordinate_version: a.coordinate_version,
          segments: a.segments,
          quote: 'not there',
        },
        {
          source_revision_id: A,
          span_id: 'a-u1',
          coordinate_version: a.coordinate_version,
          segments: [{unit_id: 'u2', start: 0, end: 1}],
        },
      ],
    },
    session.budget,
  );
  assert.deepEqual(
    batch.evidence.map(
      e =>
        e.kind === 'source_text' && [
          e.span.source_revision_id,
          e.span.attribution,
        ],
    ),
    [
      [A, 'Synthetic source A, synthetic attribution'],
      [B, 'Synthetic source B, synthetic attribution'],
    ],
  );
  assert.equal(batch.citations.length, 1);
  assert.deepEqual(
    batch.limitations.map(l => l.scope),
    ['citations'],
  );
});

test('evidence beyond the result allowance is deferred in order, never dropped', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'a-u2', 'a-unit']);
  const budget = new RequestBudget({...roomy, resultBytes: 1100});
  const {batch, deferred} = assembleBatch(
    {
      release_id: 'rel-2',
      mode: 'passage',
      depth: 'standard',
      delivered_scope: null,
      context_scope: null,
      evidence: read.spans.map(span => ({kind: 'source_text' as const, span})),
      citations: [],
      searched_scope: [],
      coverage: [],
      limitations: [],
      remaining: null,
      continuation: null,
      guidance_version: 'g/1',
    },
    budget,
  );
  assert.ok(batch.evidence.length >= 1 && deferred.length >= 1);
  assert.deepEqual(
    [...batch.evidence, ...deferred].map(
      e => e.kind === 'source_text' && e.span.span_id,
    ),
    ['a-u1', 'a-u2', 'a-unit'],
  );
  assert.equal(batch.limitations.at(-1)?.state, 'budget');
});

test('every batch, envelope included, fits the result allowance', async () => {
  clearSearchCache();
  const fixture = buildFixture({pageCap: 2048, commonCount: 48});
  const batches = await drain(fixture, new PagedIndexSearch(), workload);
  for (const batch of batches)
    assert.ok(
      Buffer.byteLength(JSON.stringify(batch)) <=
        limitsFor({}, 'passage').resultBytes,
    );
  assert.equal(batches.at(-1)!.remaining, null);
});

test('a large envelope defers uncharged evidence instead of exceeding the allowance', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const read = await readSpans(session, ['a-u1', 'a-u2']);
  const many = Array.from({length: 30}, (_, i) => ({
    state: 'missing_index' as const,
    scope: `source-${i}`,
    detail: 'synthetic limitation text',
  }));
  const base = {
    release_id: 'rel-2',
    mode: 'passage',
    depth: 'standard',
    delivered_scope: null,
    context_scope: null,
    citations: [],
    searched_scope: [],
    coverage: [],
    limitations: many,
    remaining: null,
    continuation: null,
    guidance_version: 'g/1',
  };
  const items = read.spans.map(span => ({kind: 'source_text' as const, span}));
  // Room for the envelope and the first item only; per-item charging alone would admit both.
  const cap =
    Buffer.byteLength(JSON.stringify({...base, evidence: [items[0]]})) + 200;
  const {batch, deferred} = assembleBatch(
    {...base, evidence: items},
    new RequestBudget({...roomy, resultBytes: cap}),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= cap);
  assert.ok(deferred.length >= 1);
  assert.throws(
    () =>
      assembleBatch(
        {
          release_id: 'rel-2',
          mode: 'passage',
          depth: 'standard',
          delivered_scope: null,
          context_scope: null,
          evidence: [],
          citations: [],
          searched_scope: [],
          coverage: [],
          limitations: many,
          remaining: null,
          continuation: null,
          guidance_version: 'g/1',
        },
        new RequestBudget({...roomy, resultBytes: 500}),
      ),
    state('exceeds_limits'),
  );
});
