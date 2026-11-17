import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { buildPassageFixture, HEB } from './passage-fixture.ts';

test('mapping lookup selects checked ranges and selected explicit links, with stable paging and cache', async () => {
  const { env, db } = buildPassageFixture();
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('map','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  db.sqlite.prepare(`INSERT INTO reader_reference_bases VALUES ('base','map',?,'nrsva/1','syn/1',?, '{}')`)
    .run(HEB, JSON.stringify({ ranges: [{ book_id: 'Gen', chapter: 1, first_verse: 1, last_verse: 3 }] }));
  db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('override','map',?,'nrsva/1','Gen.1.2','evidence:heb1#Gen.1.3','numbered_text',0,'exact','{}',NULL)`)
    .run(HEB);
  db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('gap','map',?,'nrsva/1','Gen.1.4',NULL,'numbered_text',0,'missing','{}','Not supplied')`)
    .run(HEB);
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-m','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-m', output_id FROM release_outputs WHERE release_id='rel-p'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-m','map')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-m' WHERE singleton_id=1`);
  const session = await ReadSession.open(env, { d1Calls: 10, r2Reads: 4, pageBytes: 16384, r2Bytes: 65536, resultBytes: 16384, rowsPerQuery: 2 });
  const references = [1, 2, 4].map(verse => ({ ref: `Gen.1.${verse}`, book: 'Gen', chapter: 1, verse, native_units: [`Gen.1.${verse}`] }));
  const input = { references, scheme: 'nrsva/1', sources: [HEB] };
  const first = await session.query('reader_mappings', input);
  assert.equal(first.more, true);
  assert.deepEqual(first.rows.map(r => [r.reader_ref, r.span_id]), [['Gen.1.1', 'evidence:heb1#Gen.1.1'], ['Gen.1.2', 'evidence:heb1#Gen.1.3']]);
  const last = first.rows.at(-1)!;
  const second = await session.query('reader_mappings', { ...input, after: [Number(last.position), String(last.source_revision_id), Number(last.role_order), Number(last.ordinal), String(last.mapping_id)] });
  assert.equal(second.rows[0].status, 'missing');
  assert.equal(second.rows[0].span_id, null);
  const calls = session.budget.usage().d1Calls;
  assert.equal(JSON.stringify(await session.query('reader_mappings', input)), JSON.stringify(first));
  assert.equal(session.budget.usage().d1Calls, calls);
});
