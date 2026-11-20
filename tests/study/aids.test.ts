import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { A, buildFixture } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { AID_LIMITS, STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
import { aidBatch } from '../../services/study/src/operators/aids.ts';
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
    next = result.continuation;
    if (!next) break;
  }
  assert.equal(next, null);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), body);
  const routed = await study(f.env, { mode: 'word_study', search_leads: [{ lookup: 'lexicon', key: 'G1234' }] });
  assert.equal((routed.evidence as unknown[]).length, 1);
  assert.ok(routed.continuation, 'Study selects the larger bounded allowance for language-aid retrieval');
  f.bucket.corrupt.add('synthetic/long-body');
  const corrupt = await aidBatch(await ReadSession.open(f.env, AID_LIMITS), { ...workload, key: 'G1234' }, null, 'test');
  assert.equal(corrupt.evidence.length, 0);
  assert.ok(corrupt.limitations.some(item => item.state === 'corrupt'));
});
