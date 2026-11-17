import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { buildPassageFixture, GRK, HEB } from './passage-fixture.ts';
import { study } from '../../services/study/src/coordinator.ts';
import { createHash } from 'node:crypto';
import { QUERIES } from '../../services/study/src/read/queries.ts';
import { passageBatch } from '../../services/study/src/operators/passage.ts';

function mappedFixture(title = false, gapBetween = false) {
  const { env, db } = buildPassageFixture(false);
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('map','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  db.sqlite.prepare(`INSERT INTO reader_reference_bases VALUES ('base','map',?,'nrsva/1','syn/1',?, '{}')`)
    .run(HEB, JSON.stringify({ ranges: [{ book_id: 'Gen', chapter: 1, first_verse: 1, last_verse: 3 }] }));
  if (gapBetween) {
    db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('gap-between','map',?,'nrsva/1','Gen.1.2',NULL,'numbered_text',0,'missing','{}','Not supplied')`).run(HEB);
  } else {
    db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('override','map',?,'nrsva/1','Gen.1.2','evidence:heb1#Gen.1.3','numbered_text',0,'exact','{}',NULL)`).run(HEB);
  }
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

test('a page boundary between a superscription and its verse resumes in order', async () => {
  const { env } = mappedFixture(true);
  const limits = { d1Calls: 10, r2Reads: 4, pageBytes: 16384, r2Bytes: 65536, resultBytes: 16384, rowsPerQuery: 1 };
  const request = { mode: 'passage', depth: 'focused', language: 'en', references: ['Gen 1:1'], sources: [HEB], context: false };
  const first = await passageBatch(await ReadSession.open(env, limits), request, null, 'test');
  assert.equal(first.evidence.length, 1);
  assert.equal(first.evidence[0].kind === 'source_text' && first.evidence[0].display_role, 'superscription');
  assert.ok(first.continuation);
  assert.ok(first.limitations.some(l => /incomplete until continuation/.test(l.detail)));
  const second = await passageBatch(await ReadSession.open(env, limits), request, first.continuation, 'test');
  assert.equal(second.evidence.length, 1);
  assert.equal(second.evidence[0].kind === 'source_text' && second.evidence[0].display_role, 'numbered_text');
  assert.equal(second.continuation, null);
});

test('a gap between delivered and deferred evidence is reported once across continuation', async () => {
  const { env } = mappedFixture(false, true);
  const limits = { d1Calls: 10, r2Reads: 4, pageBytes: 16384, r2Bytes: 65536, resultBytes: 4900, rowsPerQuery: 20 };
  const request = { mode: 'passage', depth: 'focused', language: 'en', references: ['Gen 1:1-3'], sources: [HEB], context: false };
  const first = await passageBatch(await ReadSession.open(env, limits), request, null, 'test');
  assert.equal(first.evidence.length, 1);
  assert.ok(first.continuation);
  assert.equal(first.limitations.filter(l => l.scope === 'Gen.1.2').length, 1);
  const second = await passageBatch(await ReadSession.open(env, limits), request, first.continuation, 'test');
  assert.equal(second.evidence.length, 1);
  assert.equal(second.limitations.filter(l => l.scope === 'Gen.1.2').length, 0);
  assert.equal(second.continuation, null);
});

test('a gap after deferred evidence waits for its own continuation and is not lost', async () => {
  const { env } = mappedFixture();
  const limits = { d1Calls: 10, r2Reads: 4, pageBytes: 16384, r2Bytes: 65536, resultBytes: 4900, rowsPerQuery: 20 };
  const request = { mode: 'passage', depth: 'focused', language: 'en', references: ['Gen 1:1-4'], sources: [HEB], context: false };
  let continuation: string | null = null;
  let gaps = 0;
  const delivered: string[] = [];
  for (let i = 0; i < 5; i++) {
    const batch = await passageBatch(await ReadSession.open(env, limits), request, continuation, 'test');
    if (i === 0) assert.equal(batch.limitations.filter(l => l.scope === 'Gen.1.4').length, 0);
    gaps += batch.limitations.filter(l => l.scope === 'Gen.1.4').length;
    delivered.push(...batch.evidence.map(item => item.kind === 'source_text' ? item.reader_reference ?? '' : ''));
    continuation = batch.continuation;
    if (!continuation) break;
  }
  assert.equal(continuation, null);
  assert.equal(gaps, 1);
  assert.deepEqual(delivered, ['Gen.1.1', 'Gen.1.2', 'Gen.1.3']);
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

test('Isaiah and First Samuel retrieve their own reader mappings', async () => {
  const { env, db } = mappedFixture();
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('book-map','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  const link = db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES (?, 'book-map', ?, 'nrsva/1', ?, ?, 'numbered_text', 0, 'exact', '{}', NULL)`);
  link.run('isa', HEB, 'Isa.1.1', 'evidence:heb1#Gen.1.1');
  link.run('sam', HEB, '1Sam.1.1', 'evidence:heb1#Gen.1.2');
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-books','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-books', output_id FROM release_outputs WHERE release_id='rel-m'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-books', 'book-map')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-books' WHERE singleton_id=1`);
  for (const [input, expectedRef, expectedUnit] of [
    ['Isa', 'Isa.1.1', 'Gen.1.1'], ['Isaiah', 'Isa.1.1', 'Gen.1.1'],
    ['1Sa', '1Sam.1.1', 'Gen.1.2'], ['1 Samuel', '1Sam.1.1', 'Gen.1.2'],
  ]) {
    const result = await study(env, { mode: 'passage', depth: 'focused', references: [`${input} 1:1`], sources: [HEB] }) as {
      evidence: { reader_reference: string; span: { segments: { unit_id: string }[] } }[];
    };
    assert.deepEqual(result.evidence.map(e => [e.reader_reference, e.span.segments[0].unit_id]), [[expectedRef, expectedUnit]], input);
  }
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

test('Malachi reader chapter 4 resolves to native chapter 3 in a synthetic release', async () => {
  const { env, db } = mappedFixture();
  const prepared = db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES (?, ?, ?, 'fixture/1','{}','{}','{}')`);
  prepared.run('mal-text', 'evidence', JSON.stringify([HEB]));
  prepared.run('mal-map', 'reader_reference', JSON.stringify([HEB]));
  const payload = db.sqlite.prepare('INSERT INTO text_payloads VALUES (?, ?)');
  const span = db.sqlite.prepare(`INSERT INTO native_spans VALUES (?, 'mal-text', ?, NULL, 'verse', ?, ?, 'syn/1', ?, '{}', ?, '[]', 'preserved')`);
  const link = db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES (?, 'mal-map', ?, 'nrsva/1', ?, ?, 'numbered_text', 0, 'exact', '{}', NULL)`);
  for (let verse = 1; verse <= 6; verse++) {
    const unit = `Mal.3.${verse + 18}`;
    const text = `synthetic ${unit}`;
    const digest = createHash('sha256').update(text).digest('hex');
    payload.run(digest, text);
    span.run(`mal-span-${verse}`, HEB, unit, verse, JSON.stringify([{ unit_id: unit, start: 0, end: text.length }]), digest);
    link.run(`mal-link-${verse}`, HEB, `Mal.4.${verse}`, `mal-span-${verse}`);
  }
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-mal','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-mal', output_id FROM release_outputs WHERE release_id='rel-m'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-mal', 'mal-text'), ('rel-mal', 'mal-map')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-mal' WHERE singleton_id=1`);
  const result = await study(env, { mode: 'passage', depth: 'focused', references: ['Mal 4:1-6'], sources: [HEB] }) as {
    evidence: { reader_reference: string; span: { segments: { unit_id: string }[] } }[];
  };
  assert.deepEqual(result.evidence.map(e => [e.reader_reference, e.span.segments[0].unit_id]),
    Array.from({ length: 6 }, (_, i) => [`Mal.4.${i + 1}`, `Mal.3.${i + 19}`]));
});

test('an extracted mapping slice retains the selected native verse notes with their scope', async () => {
  const { env, db } = buildPassageFixture(false);
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES ('slice-map','reader_reference',?, 'fixture/1','{}','{}','{}')`).run(JSON.stringify([HEB]));
  const text = 'synthetic slice';
  const digest = createHash('sha256').update(text).digest('hex');
  db.sqlite.prepare('INSERT INTO text_payloads VALUES (?, ?)').run(digest, text);
  db.sqlite.prepare(`INSERT INTO native_spans VALUES ('slice','slice-map',?,NULL,'numbered_text','Gen 1:2 slice',0,'syn/1',?,'{}',?,'[]','extracted')`)
    .run(HEB, JSON.stringify([{ unit_id: 'Gen.1.2', start: 0, end: text.length }]), digest);
  db.sqlite.prepare(`INSERT INTO reader_reference_links VALUES ('slice-link','slice-map',?,'nrsva/1','Gen.1.2','slice','numbered_text',0,'partial','{}',NULL)`).run(HEB);
  db.sqlite.prepare(`INSERT INTO releases VALUES ('rel-slice','m','r',?,'c','q','s')`)
    .run(JSON.stringify({ evidence_records: '1', reader_scheme_version: 'nrsva/1' }));
  db.sqlite.exec(`INSERT INTO release_outputs SELECT 'rel-slice', output_id FROM release_outputs WHERE release_id='rel-p'`);
  db.sqlite.exec(`INSERT INTO release_outputs VALUES ('rel-slice', 'slice-map')`);
  db.sqlite.exec(`UPDATE release_selection SET current_release_id='rel-slice' WHERE singleton_id=1`);
  const result = await study(env, { mode: 'passage', depth: 'focused', references: ['Gen 1:2'], sources: [HEB] }) as {
    evidence: { annotations: { kind: string; native_span_id?: string }[] }[];
  };
  assert.equal(result.evidence[0].annotations[0].kind, 'textual_variants');
  assert.equal(result.evidence[0].annotations[0].native_span_id, 'evidence:heb1#Gen.1.2');
});
