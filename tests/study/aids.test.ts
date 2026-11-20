import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A, buildFixture } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
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
