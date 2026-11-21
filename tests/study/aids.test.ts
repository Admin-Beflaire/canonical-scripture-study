import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { A, buildFixture } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { AID_LIMITS, STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
import { aidBatch } from '../../services/study/src/operators/aids.ts';
import { languageBatch } from '../../services/study/src/operators/language.ts';
import type { SearchAdapter, SearchHit } from '../../services/study/src/read/search.ts';
import { study } from '../../services/study/src/coordinator.ts';

function aids() {
  const f = buildFixture();
  f.select(null, null);
  const insert = f.db.sqlite.prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const add = (id: string, out: string, span: string, kind: string, details: object) =>
    insert.run(id, out, A, span, kind, 'synthetic lexicon', '{}', JSON.stringify(details));
  add('lex-one', 'syn-ev', 'a-u1', 'lexicon_entry', { entry_id: 'entry-one', strong_base: 'H1234', entry_key: 'entry-one' });
  const commit = 'a'.repeat(40);
  add('lex-two', 'syn-ev', 'a-u2', 'lexicon_entry', { entry_id: `oshb-lexical-index:${commit}:x`,
    strong_base: 'H1234', entry_key: 'entry-two', references: [['a', '1234', null, null], ['b', null, null, null]] });
  add('lex-old', 'syn-ev-old', 'a-old', 'lexicon_entry', { entry_id: 'old', strong_base: 'H1234', entry_key: 'old' });
  add('grammar-one', 'syn-ev', 'a-u1', 'grammar_expansion', { code: 'Ncmsa', entry_id: 'grammar-one' });
  f.select('rel-2', 'rel-1');
  return f;
}

const workload = { mode: 'word_study', depth: 'standard', language: 'en', lookup: 'lexicon', key: 'H1234', sources: null };

test('lexical entries are attributed, retain alternatives and follow selected-release BDB links', async () => {
  const f = aids();
  const session = await ReadSession.open(f.env);
  const result = await aidBatch(session, workload, null, 'test');
  assert.equal(result.evidence.length, 2);
  const [a, b] = result.evidence;
  assert.equal(a.kind, 'language_aid');
  assert.equal(b.kind, 'language_aid');
  if (a.kind !== 'language_aid' || b.kind !== 'language_aid') throw new Error('missing aids');
  assert.equal(a.span.source_revision_id, A);
  assert.ok(a.span.text?.length);
  assert.deepEqual(b.details.linked_entry_keys, [`oshb-bdb:${'a'.repeat(40)}:a`, `oshb-bdb:${'a'.repeat(40)}:b`]);
  assert.equal(result.continuation, null);
});

test('pagination resumes in order and continuation rejects changed lookup', async () => {
  const f = aids();
  const limits = { ...STARTING_LIMITS, rowsPerQuery: 1 };
  const first = await aidBatch(await ReadSession.open(f.env, limits), workload, null, 'test');
  assert.equal(first.evidence.length, 1);
  assert.ok(first.continuation);
  const second = await aidBatch(await ReadSession.open(f.env, limits), workload, first.continuation, 'test');
  assert.equal(second.evidence.length, 1);
  assert.equal(second.continuation, null);
  await assert.rejects(aidBatch(await ReadSession.open(f.env, limits), { ...workload, key: 'H1235' }, first.continuation, 'test'));
});

test('Study routes exact grammar explanations and reports missing entries', async () => {
  const f = aids();
  const result = await study(f.env, { mode: 'word_analysis', search_leads: [{ lookup: 'grammar_info', key: 'Ncmsa' }] });
  assert.equal((result.evidence as Array<{kind: string}>)[0].kind, 'language_aid');
  const missing = await study(f.env, { mode: 'word_study', search_leads: [{ lookup: 'lexicon', key: 'G1' }] });
  assert.equal((missing.limitations as Array<{state: string}>)[0].state, 'missing_evidence');
});


test('long verified lexical bodies continue without loss and preserve exact source coordinates', async () => {
  const f = aids();
  f.select(null, null);
  const body = 'α😀 abc '.repeat(7800);
  const bytes = Buffer.from(body);
  const digest = createHash('sha256').update(bytes).digest('hex');
  f.db.sqlite.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('long-body', A, 'syn-ev', digest, bytes.length, 'text/utf-8', 'synthetic/long-body');
  f.bucket.objects.set('synthetic/long-body', bytes);
  f.db.sqlite.prepare(`INSERT INTO native_spans(id, output_id, source_revision_id, kind, label, native_order,
      coordinate_version, segments_json, basis_json, body_ranges_json, reading_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('long-span', 'syn-ev', A, 'lexicon_entry', 'long', 100, 'syn:unicode-scalars/1',
      JSON.stringify([{ unit_id: 'long-unit', start: 0, end: Array.from(body).length }]), '{}',
      JSON.stringify([{ segment_ordinal: 0, artifact_id: 'long-body', byte_offset: 0, byte_length: bytes.length, sha256: digest }]), 'extracted');
  f.db.sqlite.prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('long-annotation', 'syn-ev', A, 'long-span', 'lexicon_entry', 'synthetic', '{}', JSON.stringify({ strong_base: 'G1234' }));
  f.select('rel-2', 'rel-1');
  let next: string | null = null;
  const chunks: string[] = [];
  let expectedStart = 0;
  let firstReadCount = 0;
  for (let i = 0; i < 10; i++) {
    const result = await aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, next, 'test');
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= STARTING_LIMITS.resultBytes);
    for (const item of result.evidence) if (item.kind === 'language_aid' && item.span.span_id === 'long-span') {
      assert.equal(item.span.segments[0].start, expectedStart);
      const text = item.span.text![0];
      expectedStart += Array.from(text).length;
      assert.equal(item.span.segments[0].end, expectedStart);
      chunks.push(text);
    }
    const longReads = f.bucket.reads.filter(read => read.key === 'synthetic/long-body').length;
    if (i === 0) {
      firstReadCount = longReads;
      assert.ok(firstReadCount > 1, 'the first part reads and verifies the source range');
    } else {
      assert.equal(longReads, firstReadCount, 'continuation reuses verified wording without R2 reads');
    }
    next = result.continuation;
    if (!next) break;
  }
  assert.equal(next, null);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), body);
  const routed = await study(f.env, { mode: 'word_study', search_leads: [{ lookup: 'lexicon', key: 'G1234' }] });
  assert.equal((routed.evidence as unknown[]).length, 1);
  assert.ok(routed.continuation, 'Study selects the larger bounded allowance for language-aid retrieval');
  const pending = await aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, null, 'test');
  assert.ok(pending.continuation);
  f.select('rel-1', 'rel-2');
  await assert.rejects(
    aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, pending.continuation, 'test'),
    /Continuation entry is no longer selected/,
  );
  f.select('rel-2', 'rel-1');
  const beforeReselection = f.bucket.reads.filter(read => read.key === 'synthetic/long-body').length;
  await aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, null, 'test');
  assert.ok(f.bucket.reads.filter(read => read.key === 'synthetic/long-body').length > beforeReselection,
    'reselected source is verified again after a release change');
  f.bucket.corrupt.add('synthetic/long-body');
  const corrupt = await aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, null, 'test');
  assert.equal(corrupt.evidence.length, 0);
  assert.ok(corrupt.limitations.some(item => item.state === 'corrupt'));
});


test('Matthew 1 onoma (G3686) word-study attaches attributed lexicon and grammar once for repeated occurrences', async () => {
  const f = aids();
  f.select(null, null);
  const add = f.db.sqlite.prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('lex-onoma', 'syn-ev', A, 'a-u1', 'lexicon_entry', 'synthetic Greek lexicon', '{}',
    JSON.stringify({ entry_id: 'G3686', strong_base: 'G3686', entry_key: 'onoma' }));
  add.run('grammar-onoma', 'syn-ev', A, 'a-u2', 'grammar_expansion', 'synthetic Greek morphology', '{}',
    JSON.stringify({ code: 'N-ASN', entry_id: 'N-ASN' }));
  f.select('rel-2', 'rel-1');

  const positions = ['Mat.1.21', 'Mat.1.23', 'Mat.1.25'];
  const hits: SearchHit[] = positions.map((unit, i) => ({
    source_revision_id: A, span_id: 'a-u1', coordinate_version: 'syn:unicode-scalars/1', native_order: i,
    occurrence_id: unit + ':33:38', form: 'ὄνομα',
    native_reference: { schema_version: 'native-reference/1', source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1', segments: [{ unit_id: unit, start: 33, end: 38 }] },
    analyses: [{ analysis_id: unit + ':1', analysis_revision_id: 'syn:tags', provider: 'synthetic TAGNT',
      lemma_id: 'G3686', grammar: { language: 'greek', morphology: 'N-ASN' }, basis: 'TAGNT dStrong=Grammar' }],
  }));
  const adapter: SearchAdapter = { async search() {
    return { state: 'complete', lookup: 'lemma', key: 'G3686', hits, searched: [], limitations: [],
      remaining: null, ranked: false as const, resume_after: hits.map((hit, i) => ({
        source: A, output: 'syn-word', order: i, dir: 0, entry: 0, after: null, anchor: null,
      })) };
  } };
  const prepare = f.db.prepare.bind(f.db);
  let lexCalls = 0, gramCalls = 0;
  f.db.prepare = sql => {
    if (sql.includes("a.kind = 'lexicon_entry'")) lexCalls++;
    if (sql.includes("a.kind = 'grammar_expansion'")) gramCalls++;
    return prepare(sql);
  };
  const session = await ReadSession.open(f.env, AID_LIMITS);
  const batch = await languageBatch(session,
    { mode: 'word_study', depth: 'focused', language: 'en', lookup: 'lemma', key: 'G3686', sources: [A] },
    null, 'test', [], adapter);
  const attached = batch.evidence.filter(item => item.kind === 'language_aid');
  assert.equal(attached.length, 2, 'lexicon and morphology evidence included once, not once per occurrence');
  assert.deepEqual(attached.map(item => item.kind === 'language_aid' ? item.provider : ''), [
    'synthetic Greek lexicon', 'synthetic Greek morphology',
  ]);
  assert.equal(lexCalls, 1); assert.equal(gramCalls, 1);
  for (const hit of batch.evidence.filter(item => item.kind === 'search_hit')) {
    if (hit.kind !== 'search_hit') continue;
    assert.equal(hit.hit.aid_matches?.[0].lexicon.length, 1);
    assert.equal(hit.hit.aid_matches?.[0].grammar.length, 1);
  }
  assert.equal(batch.continuation, null);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= AID_LIMITS.resultBytes);
  assert.ok(session.budget.usage().d1Calls <= AID_LIMITS.d1Calls);
  assert.ok(session.budget.usage().r2Reads <= AID_LIMITS.r2Reads);
  const standalone = await study(f.env, { mode: 'word_study', search_leads: [{ lookup: 'lexicon', key: 'G3686' }] });
  assert.ok((standalone.evidence as Array<{ kind: string }>).some(item => item.kind === 'language_aid'));
  // One study can span multiple bounded calls. The complete, selected aid entries
  // are reused rather than queried and verified again.
  const next = await languageBatch(await ReadSession.open(f.env, AID_LIMITS),
    { mode: 'word_study', depth: 'focused', language: 'en', lookup: 'lemma', key: 'G3686', sources: [A] },
    null, 'test', [], adapter);
  assert.equal(lexCalls, 1, 'cached lexicon not queried again');
  assert.equal(gramCalls, 1, 'cached grammar not queried again');
  assert.equal(next.evidence.filter(item => item.kind === 'language_aid').length, 2);
});
