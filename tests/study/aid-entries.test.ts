import assert from 'node:assert/strict';
import {test} from 'node:test';
import {A, B, buildFixture} from './fixture.ts';
import {addAids} from './aid-fixture.ts';
import {QUERIES} from '../../services/study/src/read/queries.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {limitsFor} from '../../services/study/src/read/budget.ts';
import {aidBatch} from '../../services/study/src/operators/aids.ts';
import type {Batch} from '../../services/study/src/results/batch.ts';

const workload = {
  mode: 'word_study',
  depth: 'standard',
  language: 'en',
  lookup: 'lexicon',
  key: 'H1234',
  sources: null,
};

function withEntries() {
  const f = buildFixture();
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      provider: 'synthetic lexicon',
      text: 'First entry',
      details: {strong_base: 'H1234', entry_key: 'one'},
    },
    {
      kind: 'lexicon_entry',
      provider: 'synthetic lexicon',
      text: null,
      details: {strong_base: 'H1234', entry_key: 'gap'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  return f;
}

test('an entry comes back with its attribution, coordinates and details, a gap without wording', async () => {
  const f = withEntries();
  const result = await aidBatch(
    await ReadSession.open(f.env, limitsFor({}, 'aid')),
    workload,
    null,
    'test',
  );
  const [first] = result.evidence;
  if (first.kind !== 'language_aid') throw new Error('missing aid');
  assert.deepEqual(
    {
      id: first.span.span_id,
      kind: first.span.kind,
      order: first.span.native_order,
      reading: first.span.reading_kind,
      coordinates: first.span.coordinate_version,
      segments: first.span.segments,
      text: first.span.text,
      provider: first.provider,
      revision: first.span.source_revision_id,
      attribution: first.span.attribution,
    },
    {
      id: 'syn-ev#entry0000',
      kind: 'lexicon_entry',
      order: 0,
      reading: 'extracted',
      coordinates: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'p000', start: 0, end: 11}],
      text: ['First entry'],
      provider: 'synthetic lexicon',
      revision: A,
      attribution: `${first.span.source_name}, synthetic attribution`,
    },
  );
  assert.equal(first.details.entry_key, 'one');
  const gap = result.evidence[1];
  assert.equal(
    gap.kind === 'language_aid' && gap.span.text,
    null,
    'a recorded gap is delivered without wording',
  );
  assert.ok(
    result.limitations.some(
      item =>
        item.state === 'missing_evidence' && item.scope === 'syn-ev#entry0001',
    ),
  );
  assert.equal(result.citations.length, 2);
});

test('a source filter keeps only entries of the named source revisions', async () => {
  const f = withEntries();
  const session = await ReadSession.open(f.env, limitsFor({}, 'aid'));
  assert.equal(
    (await aidBatch(session, {...workload, sources: [B]}, null, 'test'))
      .evidence.length,
    0,
  );
  assert.equal(
    (
      await aidBatch(
        await ReadSession.open(f.env, limitsFor({}, 'aid')),
        {...workload, sources: [A]},
        null,
        'test',
      )
    ).evidence.length,
    2,
  );
});

/** Two entries of one output; the first is stored changed. Returns the batch read for H1234. */
async function readWith(edit?: (line: string) => string, format?: string) {
  const f = buildFixture();
  f.select(null, null);
  addAids(
    f,
    'syn-ev',
    [
      {
        kind: 'lexicon_entry',
        text: 'First entry',
        details: {strong_base: 'H1234', entry_key: 'one'},
        edit,
      },
      {
        kind: 'lexicon_entry',
        text: 'Second entry',
        details: {strong_base: 'H1234', entry_key: 'two'},
      },
    ],
    A,
    format,
  );
  f.select('rel-2', 'rel-1');
  return aidBatch(
    await ReadSession.open(f.env, limitsFor({}, 'aid')),
    workload,
    null,
    'test',
  );
}
const keys = (batch: Batch) =>
  batch.evidence.map(item =>
    item.kind === 'language_aid' ? item.details.entry_key : null,
  );

test('a line that disagrees with its row is reported corrupt and the other entries still come back', async () => {
  const cases: [string, (line: string) => string][] = [
    [
      'another entry key',
      line => line.replace('"entry_key":"one"', '"entry_key":"two"'),
    ],
    ['another entry number', line => line.replace('"entry":0', '"entry":9')],
    [
      'another span id',
      line => line.replace('syn-ev#entry0000', 'syn-ev#entry0007'),
    ],
    [
      'a gap that has wording',
      line =>
        line.replace('"reading_kind":"extracted"', '"reading_kind":"gap"'),
    ],
    [
      'no details',
      line => line.replace(/"details":\{[^}]*\}/, '"details":null'),
    ],
    ['not JSON', () => 'not json\n'],
  ];
  for (const [name, edit] of cases) {
    const result = await readWith(edit);
    assert.deepEqual(keys(result), ['two'], name);
    assert.ok(
      result.limitations.some(
        item => item.state === 'corrupt' && item.scope === 'one',
      ),
      name,
    );
  }
});

test('entries that are not in an entries file are reported corrupt, not read', async () => {
  const result = await readWith(undefined, 'text/utf-8');
  assert.deepEqual(keys(result), []);
  assert.ok(result.limitations.some(item => item.state === 'corrupt'));
});

test('every aid lookup runs from its index: no scan of the entry table and no sort', async () => {
  const f = withEntries();
  const sql = f.db.sqlite;
  const plan = (name: keyof typeof QUERIES, values: (string | number)[]) =>
    (
      sql
        .prepare('EXPLAIN QUERY PLAN ' + QUERIES[name].sql)
        .all('rel-2', ...values) as {detail: string}[]
    )
      .map(row => row.detail)
      .join(' | ');
  for (const [name, values] of [
    ['lexicon_strong', ['H1234', '', -1, 51]],
    ['lexicon_entry', ['one', '', -1, 51]],
    ['grammar_expansion', ['Ncmsa', '', -1, 51]],
    ['proper_name', ['G1234G', '', -1, 51]],
  ] as const) {
    const text = plan(name, [...values]);
    assert.match(
      text,
      /SEARCH e USING (COVERING )?INDEX aid_entries_(lookup|entry_key)/,
      `${name}: ${text}`,
    );
    assert.doesNotMatch(text, /SCAN e|TEMP B-TREE/, `${name}: ${text}`);
  }
  const presence = plan('linked_aid_presence', [
    '[["proper_name","G1234G"]]',
    51,
  ]);
  assert.match(
    presence,
    /SEARCH e USING (COVERING )?INDEX aid_entries_lookup/,
    presence,
  );
});
