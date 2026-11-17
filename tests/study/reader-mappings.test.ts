import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { buildPassageFixture, GRK, HEB } from './passage-fixture.ts';
import { study } from '../../services/study/src/coordinator.ts';
import { createHash } from 'node:crypto';
import { QUERIES } from '../../services/study/src/read/queries.ts';

function mappedFixture(title = false) {
  const { env, db } = buildPassageFixture(false);
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('map','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  db.sqlite.prepare(`INSERT INTO reader_reference_bases VALUES ('base','map',?,'nrsva/1','syn/1',?, '{}')`)
    .run(HEB, JSON.stringify({ ranges: [{ book_id: 'Gen', chapter: 1, first_verse: 1, last_verse: 3 }] }));
  db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('override','map',?,'nrsva/1','Gen.1.2','evidence:heb1#Gen.1.3','numbered_text',0,'exact','{}',NULL)`)
    .run(HEB);
  db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('gap','map',?,'nrsva/1','Gen.1.4',NULL,'numbered_text',0,'missing','{}','Not supplied')`)
    .run(HEB);
  if (title) {
    const text = 'synthetic title';
    const digest = createHash('sha256').update(text).digest('hex');
    db.sqlite.prepare(`INSERT INTO text_payloads VALUES (?,?)`).run(digest, text);
    db.sqlite.prepare(`INSERT INTO native_spans VALUES ('title','map',?,NULL,'superscription','Gen 1 title',0,'syn/1',?,'{}',?,'[]','preserved')`)
      .run(HEB, JSON.stringify([{ unit_id: 'Gen.1.1', start: 0, end: text.length }]), digest);
    db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('title-link','map',?,'nrsva/1','Gen.1.1','title','superscription',0,'exact','{}',NULL)`).run(HEB);
  }
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-m','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-m', output_id FROM release_outputs WHERE release_id='rel-p'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-m','map')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-m' WHERE singleton_id=1`);
  return { env, db };
}

test('mapping lookup selects checked ranges and selected explicit links, with stable paging and cache', async () => {
  const { env } = mappedFixture();
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

test('reader results place a selected superscription before numbered text', async () => {
  const { env } = mappedFixture(true);
  const result = await study(env, { mode: 'passage', depth: 'focused', references: ['Gen 1:1'], sources: [HEB] }) as {
    evidence: { display_role: string; reader_reference: string; span: { text: string[] } }[];
  };
  assert.deepEqual(result.evidence.map(e => [e.reader_reference, e.display_role]), [['Gen.1.1', 'superscription'], ['Gen.1.1', 'numbered_text']]);
  assert.equal(result.evidence[0].span.text[0], 'synthetic title');
});

test('passage retrieves a mapped native exception and reports an explicit gap', async () => {
  const { env } = mappedFixture();
  const batch = await study(env, { mode: 'passage', depth: 'focused', references: ['Gen 1:2-4'], sources: [HEB] }) as {
    evidence: { reader_reference: string; span: { segments: { unit_id: string }[] } }[];
    limitations: { state: string; scope: string }[]; continuation: string | null;
  };
  assert.deepEqual(batch.evidence.map(e => [e.reader_reference, e.span.segments[0].unit_id]),
    [['Gen.1.2', 'Gen.1.3'], ['Gen.1.3', 'Gen.1.3']]);
  assert.ok(batch.limitations.some(l => l.state === 'unresolved_mapping' && l.scope === 'Gen.1.4'));
  assert.equal(batch.continuation, null);
});

test('source filtering and release selection never substitute another source or unselected text', async () => {
  const { env, db } = mappedFixture();
  const session = await ReadSession.open(env);
  const references = [{ ref: 'Gen.1.2', book: 'Gen', chapter: 1, verse: 2, native_units: ['Gen.1.2'] }];
  const other = await session.query('reader_mappings', { references, scheme: 'nrsva/1', sources: [GRK] });
  assert.equal(other.rows[0].status, 'uncovered');
  assert.equal(other.rows[0].span_id, null);
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-no-text','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-no-text','map')`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-no-text','evidence:heb2')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-no-text' WHERE singleton_id=1`);
  const next = await ReadSession.open(env);
  const absent = await next.query('reader_mappings', { references, scheme: 'nrsva/1', sources: [HEB] });
  assert.equal(absent.rows[0].status, 'exact');
  assert.equal(absent.rows[0].span_id, null, 'link target is withheld when its output is not selected');
});

test('a warm mapped passage remains available with only the current-release D1 call allowed', async () => {
  const { env } = mappedFixture();
  const request = { mode: 'passage' as const, depth: 'focused', references: ['Gen 1:2'], sources: [HEB] };
  let cold = 0;
  const first = await study(env, request, usage => { cold = usage.d1Calls; });
  assert.equal(cold, 4, 'current, mapping, spans and notes');
  env.MAX_D1_CALLS = 1;
  let warm = 0;
  const again = await study(env, request, usage => { warm = usage.d1Calls; });
  assert.deepEqual(again, first);
  assert.equal(warm, 1, 'cached mapping, span and note reads need no further D1 calls');
});

test('full-corpus baseline fixture uses indexed source, mapping and verse seeks', async () => {
  const { env, db } = mappedFixture();
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-scale','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-scale', output_id FROM release_outputs WHERE release_id='rel-m'`);
  for (let i = 0; i < 65; i++) {
    const output = `extra-map-${i}`;
    db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES (?, 'reader_reference', ?, 'fixture/1', '{}','{}','{}')`).run(output, JSON.stringify([HEB]));
    db.sqlite.prepare(`INSERT INTO reader_reference_bases VALUES (?, ?, ?, 'nrsva/1', 'syn/1', ?, '{}')`)
      .run(`${output}:base`, output, HEB, JSON.stringify({ ranges: [{ book_id: `Book${i}`, chapter: 1, first_verse: 1, last_verse: 20 }] }));
    db.sqlite.prepare(`INSERT INTO release_outputs VALUES ('rel-scale', ?)`).run(output);
  }
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-scale' WHERE singleton_id=1`);
  const input = { references: [{ ref: 'Gen.1.1', book: 'Gen', chapter: 1, verse: 1, native_units: ['Gen.1.1'] }], scheme: 'nrsva/1', sources: [HEB] };
  const args = ['rel-scale', ...QUERIES.reader_mappings.params(input), 21];
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${QUERIES.reader_mappings.sql}`).all(...args as (string | number | null)[])
    .map(row => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH b USING INDEX reader_reference_bases_lookup/);
  assert.match(plan, /SEARCH l USING INDEX sqlite_autoindex_reader_reference_links_2/);
  assert.match(plan, /SEARCH n USING INDEX native_spans_verse_unit/);
  assert.doesNotMatch(plan, /SEARCH ro USING COVERING INDEX sqlite_autoindex_release_outputs_1 \(release_id=\?\)\n/);
  const result = await (await ReadSession.open(env)).query('reader_mappings', input);
  assert.deepEqual(result.rows.map(r => r.reader_ref), ['Gen.1.1']);
});

test('multi-source mapped chapters continue without losing or repeating a mapping', async () => {
  const { env, db } = mappedFixture();
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('map2','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([GRK]));
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('map3','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  db.sqlite.prepare(`INSERT INTO reader_reference_bases VALUES ('base3','map3',?,'nrsva/1','syn/1',?, '{}')`)
    .run(HEB, JSON.stringify({ ranges: [{ book_id: 'Gen', chapter: 1, first_verse: 5, last_verse: 31 }] }));
  const add = db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES (?, 'map2', ?, 'nrsva/1', ?, ?, 'numbered_text', 0, 'exact', '{}', NULL)`);
  for (let verse = 1; verse <= 3; verse++) add.run(`g${verse}`, GRK, `Gen.1.${verse}`, `evidence:grk1#Mat.1.${verse}`);
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-multi','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-multi', output_id FROM release_outputs WHERE release_id='rel-m'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-multi', 'map2')`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-multi', 'map3')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-multi' WHERE singleton_id=1`);
  const request = { mode: 'passage' as const, depth: 'focused', references: ['Gen 1'], sources: [HEB, GRK] };
  let token: string | undefined;
  const found: string[] = [];
  for (let i = 0; i < 10; i++) {
    const result = await study(env, { ...request, ...(token ? { continuation: token } : {}) }) as {
      evidence: { reader_reference: string; span: { source_revision_id: string } }[]; continuation: string | null;
    };
    found.push(...result.evidence.map(e => `${e.reader_reference}:${e.span.source_revision_id}`));
    token = result.continuation ?? undefined;
    if (!token) break;
  }
  assert.equal(token, undefined);
  assert.equal(found.length, 33);
  assert.equal(new Set(found).size, 33);
  for (let verse = 1; verse <= 31; verse++) if (verse !== 4) assert.ok(found.includes(`Gen.1.${verse}:${HEB}`));
  for (let verse = 1; verse <= 3; verse++) assert.ok(found.includes(`Gen.1.${verse}:${GRK}`));
});
