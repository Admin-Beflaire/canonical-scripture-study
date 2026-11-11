import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localD1 } from '../maintenance/d1.ts';
import { MemoryBucket } from '../study/fixture.ts';
import { buildFitFixture, FIT_RELEASE } from '../../tools/cloudflare/study-fit-fixture.ts';
import { runStudyFit } from '../../tools/cloudflare/study-fit.ts';
import { clearSearchCache } from '../../services/study/src/read/search.ts';

async function staged({ selectFixture = false } = {}) {
  const fixture = await buildFitFixture();
  const db = localD1();
  for (const sql of fixture.insertSql) db.sqlite.exec(sql);
  // A different, real-looking release stays current throughout.
  db.sqlite.exec(`INSERT INTO releases VALUES ('current-release','m','r','{"evidence_records":"1"}','c','q','s')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id = '${selectFixture ? FIT_RELEASE : 'current-release'}'`);
  const bucket = new MemoryBucket();
  for (const object of fixture.objects) bucket.objects.set(object.key, object.bytes);
  return { fixture, db, bucket, env: { DATA_DB: db, PRIVATE_OBJECTS: bucket, MAX_PAGE_BYTES: 65536, REQUEST_BYTES: 262144, MAX_D1_CALLS: 25, MAX_SUBREQUESTS: 40 } };
}

test('fit fixture: 16 KB pages, a key spanning several pages, a small manifest', async () => {
  const fixture = await buildFitFixture();
  const [postings, directory, manifest] = fixture.objects;
  assert.ok(postings.bytes.length > 4 * fixture.pageCap);
  assert.ok(manifest.bytes.length <= fixture.pageCap && directory.bytes.length <= fixture.pageCap * 2);
  assert.equal(fixture.occurrences.length, 120);
  assert.ok(fixture.objects.every(o => o.key.startsWith('synthetic/fit/')));
  assert.ok(fixture.deleteSql.every(sql => sql.startsWith('DELETE FROM ') && /'fit[-:]/.test(sql)));
});

test('fit search runs the real Study adapter on the unselected fixture and continues to the end', async () => {
  clearSearchCache();
  const { fixture, env, db } = await staged();
  const seen: string[] = [];
  let continuation: string | null = null;
  for (let i = 0; i < 50; i++) {
    const result = await runStudyFit(env, continuation) as { occurrences: string[]; continuation: string | null; usage: { d1Calls: number; r2Reads: number; r2Bytes: number }; release_id: string };
    assert.equal(result.release_id, FIT_RELEASE);
    assert.ok(result.usage.d1Calls <= 2 && result.usage.r2Reads <= 4 && result.usage.r2Bytes <= 65536, JSON.stringify(result.usage));
    seen.push(...result.occurrences);
    continuation = result.continuation;
    if (!continuation) break;
  }
  assert.deepEqual(seen, fixture.occurrences);
  assert.equal(db.sqlite.prepare('SELECT current_release_id FROM release_selection').get()?.current_release_id, 'current-release');
  for (const sql of fixture.deleteSql) db.sqlite.exec(sql);
  for (const table of ['release_outputs', 'releases', 'coverage', 'artifacts', 'prepared_outputs', 'source_nodes'])
    assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === 'releases' ? 'id' : table === 'release_outputs' ? 'release_id' : table === 'source_nodes' ? 'id' : table === 'prepared_outputs' ? 'id' : 'output_id'} LIKE 'fit%'`).get()?.n, 0, table);
});

test('fit search reports a corrupt staged object instead of hits', async () => {
  clearSearchCache();
  const { fixture, env, bucket } = await staged();
  bucket.corrupt.add(fixture.objects[0].key);
  const result = await runStudyFit(env, null) as { hits: number; limitations: { state: string }[] };
  assert.equal(result.hits, 0);
  assert.deepEqual(result.limitations.map(l => l.state), ['corrupt']);
});
