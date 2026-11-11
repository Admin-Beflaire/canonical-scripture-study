import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, UNITS } from './fixture.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
import { readSpans } from '../../services/study/src/read/evidence.ts';
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
  result = await readSpans(await ReadSession.open(fixture.env, { ...roomy, r2Reads: 1 }), ['a-comment', 'a-u1']);
  assert.deepEqual([result.spans.map(s => s.span_id), result.remaining], [['a-u1'], ['a-comment']]);
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
  await assert.rejects(readArtifact(session, { ...artifact, byte_count: 9000 }, { offset: 0, length: 3000, sha256: '0'.repeat(64) }), state('exceeds_limits'));
  await assert.rejects(readArtifact(session, { ...artifact, byte_count: 70000 }), state('exceeds_limits'));
  assert.deepEqual(fixture.bucket.reads, []);
  await assert.rejects(readArtifact(session, { ...artifact, registered_locator: 'synthetic/none' }), state('corrupt'));
});
