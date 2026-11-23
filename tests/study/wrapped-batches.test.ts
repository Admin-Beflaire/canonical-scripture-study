import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addAids} from './aid-fixture.ts';
import {A, buildFixture, type Fixture} from './fixture.ts';
import {aidBatch} from '../../services/study/src/operators/aids.ts';
import {
  languageBatch,
  type LanguageWorkload,
} from '../../services/study/src/operators/language.ts';
import {nameStudyBatch} from '../../services/study/src/operators/name-study.ts';
import {limitsFor} from '../../services/study/src/read/budget.ts';
import {
  PagedIndexSearch,
  type SearchAdapter,
  type SearchHit,
} from '../../services/study/src/read/search.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {limitation} from '../../services/study/src/read/states.ts';
import type {Batch} from '../../services/study/src/results/batch.ts';
import {searchBatch} from '../../services/study/src/results/search-batch.ts';

const notes = [limitation('budget', 'fixture', 'α'.repeat(2300))];
const size = (batch: Batch) => Buffer.byteLength(JSON.stringify(batch));
const limits = limitsFor({}, 'word');
const open = (fixture: Fixture, resultBytes = limits.resultBytes) =>
  ReadSession.open(fixture.env, {...limits, resultBytes});
const ids = (batch: Batch) =>
  batch.evidence.flatMap(item =>
    item.kind === 'search_hit' ? [item.hit.occurrence_id] : [],
  );

async function follow(
  cap: number,
  next: (token: string | null) => Promise<Batch>,
) {
  const batches: Batch[] = [];
  let token: string | null = null;
  do {
    const batch = await next(token);
    assert.ok(
      size(batch) <= cap,
      `batch has ${size(batch)} bytes for cap ${cap}`,
    );
    assert.notEqual(batch.continuation, token ?? '', 'cursor must advance');
    batches.push(batch);
    assert.ok(batches.length < 15, 'retrieval must finish');
    token = batch.continuation;
  } while (token);
  return batches;
}

function wordPages(): SearchAdapter {
  const hits: SearchHit[] = Array.from({length: 5}, (_, order) => ({
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: order,
    occurrence_id: `word-${order}`,
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: order, end: order + 1}],
    },
    analyses: [{analysis_id: 'first', lemma_id: 'G2264G', grammar: {}}],
  }));
  return {
    async search(_session, {lookup, key, position}) {
      const selected = hits.slice(position?.after ? position.after[0] + 1 : 0);
      return {
        state: 'complete',
        lookup,
        key,
        hits: selected,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: selected.map(hit => ({
          source: A,
          output: 'syn-word',
          order: hit.native_order,
          dir: 0,
          entry: 0,
          after: [hit.native_order, hit.occurrence_id],
          anchor: {file: 'page', offset: 0, length: 1, sha256: 'a'.repeat(64)},
        })),
      };
    },
  };
}

function nameFixture(text?: string) {
  const fixture = buildFixture({strongLemmas: {alpha: 'G2264G'}});
  fixture.select(null, null);
  addAids(fixture, 'syn-ev', [
    {
      kind: 'proper_name',
      text,
      details: {disambiguated_strong: 'G2264G'},
    },
  ]);
  fixture.select('rel-2', 'rel-1');
  return fixture;
}

const name: LanguageWorkload = {
  mode: 'word_study',
  depth: 'focused',
  language: 'en',
  lookup: 'proper_name',
  key: 'G2264G',
  sources: null,
};

test('linked word pages fit after wrapping and resume every occurrence in order', async () => {
  const fixture = nameFixture();
  const adapter = wordPages();
  const request = {...name, lookup: 'word', key: 'a', sources: [A]};
  const bare = await searchBatch(
    await open(fixture),
    adapter,
    request,
    null,
    'test',
    notes,
  );
  const cap = size(bare);
  const batches = await follow(cap, async token =>
    languageBatch(
      await open(fixture, cap),
      request,
      token,
      'test',
      token ? [] : notes,
      adapter,
    ),
  );
  assert.ok(ids(batches[0]).length < ids(bare).length);
  assert.deepEqual(batches.flatMap(ids), ids(bare));
  assert.ok(
    batches.some(batch =>
      batch.evidence.some(item => item.kind === 'language_aid'),
    ),
  );
});

test('a name study sizes its occurrence page with the name continuation attached', async () => {
  const fixture = nameFixture();
  const request = {...name, focus: 'occurrences'} as const;
  const bare = await searchBatch(
    await open(fixture),
    new PagedIndexSearch(),
    {...request, lookup: 'lemma', sources: [A]},
    null,
    'test',
    notes,
  );
  assert.ok(ids(bare).length > 1);
  const cap = size(bare);
  const batches = await follow(cap, async token =>
    nameStudyBatch(
      await open(fixture, cap),
      request,
      token,
      'test',
      token ? [] : notes,
    ),
  );
  assert.ok(ids(batches[0]).length < ids(bare).length);
  assert.deepEqual(batches.flatMap(ids), ids(bare));
  assert.equal(
    batches
      .flatMap(batch => batch.evidence)
      .filter(item => item.kind === 'language_aid').length,
    1,
  );
});

test('a name entry fragments at the final wrapped limit and delivers every character', async () => {
  const wording = 'ὄνομα 😀 '.repeat(410);
  const fixture = nameFixture(wording);
  const bare = await aidBatch(await open(fixture), name, null, 'test', notes);
  assert.equal(bare.continuation, null);
  const cap = size(bare);
  const batches = await follow(cap, async token =>
    nameStudyBatch(
      await open(fixture, cap),
      name,
      token,
      'test',
      token ? [] : notes,
    ),
  );
  assert.ok(
    batches[0].evidence.some(
      item => item.kind === 'language_aid' && item.details.delivery_part,
    ),
  );
  const chunks = batches.flatMap(batch =>
    batch.evidence.flatMap(item =>
      item.kind === 'language_aid' ? (item.span.text ?? []) : [],
    ),
  );
  assert.equal(chunks.join(''), wording);
});
