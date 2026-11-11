import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, UNITS } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
import { readRelationships, readSpans } from '../../services/study/src/read/evidence.ts';
import { artifactFrom, readArtifact } from '../../services/study/src/read/objects.ts';
import { ReadError } from '../../services/study/src/read/states.ts';

const roomy = { ...STARTING_LIMITS, d1Calls: 10, r2Reads: 20, r2Bytes: 65536 };
const state = (s: string) => (error: unknown) => error instanceof ReadError && error.state === s;
const artifact = { id: 'syn-body', sha256: '0'.repeat(64), byte_count: 10, format: 'text/utf-8', registered_locator: 'synthetic/body/syn-body' };

test('exact wording from D1 payloads and verified R2 body ranges, with attribution', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  const result = await readSpans(session, ['a-u1', 'a-comment', 'a-gap', 'a-unit']);
  assert.deepEqual(result.limitations, []);
  const byId = Object.fromEntries(result.spans.map(s => [s.span_id, s]));
  assert.deepEqual(byId['a-u1'].text, [UNITS.u1]);
  assert.equal(byId['a-u1'].attribution, 'Synthetic source A, synthetic attribution');
  assert.deepEqual(byId['a-comment'].text, ['Synthetic ', 'alpha']);
  assert.equal(byId['a-gap'].text, null);
  assert.deepEqual(byId['a-unit'].basis, { receipt: 'syn', disputed: true });
  assert.deepEqual(fixture.bucket.reads.map(r => [r.offset, r.length]), [[0, 10], [27, 5]], 'only the cited ranges are read');
  assert.equal(JSON.stringify(result).includes('synthetic/body'), false, 'object keys never reach results');
});

test('corrupt material is withheld while independent valid evidence is returned', async () => {
  const fixture = buildFixture();
  fixture.bucket.corrupt.add('synthetic/body/syn-body');
  const session = await ReadSession.open(fixture.env, roomy);
  const result = await readSpans(session, ['a-comment', 'a-u1', 'not-there']);
  assert.deepEqual(result.spans.map(s => s.span_id), ['a-u1']);
  assert.deepEqual(result.limitations.map(l => [l.scope, l.state]), [['a-comment', 'corrupt'], ['not-there', 'missing_evidence']]);
});

test('a changed text payload fails its digest and is withheld', async () => {
  const fixture = buildFixture();
  fixture.db.sqlite.exec('DROP TRIGGER text_payloads_immutable');
  fixture.db.sqlite.exec(`UPDATE text_payloads SET exact_text = 'tampered' WHERE exact_text = '${UNITS.u2}'`);
  const result = await readSpans(await ReadSession.open(fixture.env, roomy), ['a-u2']);
  assert.deepEqual(result.limitations.map(l => l.state), ['corrupt']);
});

test('provider failure is temporary; budget leaves spans remaining, never partial wording', async () => {
  const fixture = buildFixture();
  fixture.bucket.failing.add('synthetic/body/syn-body');
  let result = await readSpans(await ReadSession.open(fixture.env, roomy), ['a-comment']);
  assert.deepEqual(result.limitations.map(l => l.state), ['temporary_failure']);
  fixture.bucket.failing.clear();
  const partlyUsed = await ReadSession.open(fixture.env, { ...roomy, r2Reads: 2 });
  partlyUsed.budget.spendRead(10);   // a fresh request could still read both ranges
  result = await readSpans(partlyUsed, ['a-comment', 'a-u1']);
  assert.deepEqual([result.spans.map(s => s.span_id), result.remaining], [['a-u1'], ['a-comment']]);
  // A span that no fresh request could read is withheld instead of remaining for ever.
  for (const limits of [{ ...roomy, r2Reads: 1 }, { ...roomy, r2Bytes: 12 }]) {
    result = await readSpans(await ReadSession.open(fixture.env, limits), ['a-comment']);
    assert.deepEqual([result.remaining, result.limitations.map(l => l.state)], [[], ['exceeds_limits']]);
  }
  result = await readSpans(await ReadSession.open(fixture.env, { ...roomy, d1Calls: 1 }), ['a-u1']);
  assert.deepEqual(result.remaining, ['a-u1']);
});

test('the resolver rejects unregistered paths, bad ranges, unsupported formats and oversized reads before reading', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  for (const locator of ['/abs', 'https://x/y', 'a/../b', 'a?b', 'a#b', 'a\\b', ''])
    assert.throws(() => artifactFrom({ ...artifact, registered_locator: locator }), state('corrupt'));
  await assert.rejects(readArtifact(session, { ...artifact, format: 'application/zip' }), state('corrupt'));
  await assert.rejects(readArtifact(session, artifact, { offset: 8, length: 5, sha256: '0'.repeat(64) }), state('corrupt'));
  await assert.rejects(readArtifact(session, { ...artifact, byte_count: 40000 }, { offset: 0, length: 20000, sha256: '0'.repeat(64) }), state('exceeds_limits'));
  await assert.rejects(readArtifact(session, { ...artifact, byte_count: 70000 }), state('exceeds_limits'));
  assert.deepEqual(fixture.bucket.reads, []);
  await assert.rejects(readArtifact(session, { ...artifact, registered_locator: 'synthetic/none' }), state('corrupt'));
});

test('relationships page by complete relationship; unselected endpoints stay unavailable', async () => {
  const fixture = buildFixture();
  fixture.select(null);
  for (let i = 0; i < 11; i++) {
    fixture.db.sqlite.exec(`INSERT INTO relationships VALUES ('rel-y${String(i).padStart(2, '0')}', 'syn-ev', 'quotation', 'directed', 'supported', '{}')`);
    fixture.db.sqlite.exec(`INSERT INTO relation_members VALUES ('rel-y${String(i).padStart(2, '0')}', 'from', 0, 'a-u2', 'exact', NULL)`);
  }
  fixture.select('rel-2', 'rel-1');
  const session = await ReadSession.open(fixture.env, roomy);
  const first = await readRelationships(session, 'a-u1');
  assert.deepEqual(first.relationships[0].members.map(m => m.endpoint.state), ['selected', 'unavailable', 'none']);
  assert.equal(first.more, false);
  const page1 = await readRelationships(session, 'a-u2', ['quotation']);
  assert.deepEqual([page1.relationships.length, page1.more, page1.after], [10, true, 'rel-y09']);
  const page2 = await readRelationships(session, 'a-u2', ['quotation'], page1.after);
  assert.deepEqual([page2.relationships.map(r => r.id), page2.more], [['rel-y10'], false]);
});
