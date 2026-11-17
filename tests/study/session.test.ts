import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFixture, A, B } from './fixture.ts';
import { buildPassageFixture, HEB } from './passage-fixture.ts';
import { ReadSession, SUPPORTED_SCHEMA_VERSIONS } from '../../services/study/src/read/session.ts';
import { QUERIES } from '../../services/study/src/read/queries.ts';
import { limitsFor, RequestBudget, STARTING_LIMITS } from '../../services/study/src/read/budget.ts';
import { ReadError } from '../../services/study/src/read/states.ts';

const roomy = { ...STARTING_LIMITS, d1Calls: 10, r2Reads: 20, r2Bytes: 65536 };
const state = (state: string) => (error: unknown) => error instanceof ReadError && error.state === state;

test('starting budgets come from CF-02 and never exceed configured Platform caps', () => {
  assert.deepEqual(limitsFor({}), STARTING_LIMITS);
  assert.deepEqual(limitsFor({ MAX_PAGE_BYTES: '65536', REQUEST_BYTES: '262144', MAX_D1_CALLS: '25', MAX_SUBREQUESTS: '40' }), STARTING_LIMITS);
  const tight = limitsFor({ MAX_PAGE_BYTES: 1024, REQUEST_BYTES: 3000, MAX_D1_CALLS: 1, MAX_SUBREQUESTS: 3 });
  assert.deepEqual([tight.pageBytes, tight.r2Bytes, tight.d1Calls, tight.r2Reads], [1024, 3000, 1, 2]);
  assert.throws(() => limitsFor({ MAX_D1_CALLS: 'many' }), state('temporary_failure'));
  assert.throws(() => limitsFor({ REQUEST_BYTES: -1 }), state('temporary_failure'));
});

test('budget counts work before it happens', () => {
  const budget = new RequestBudget(STARTING_LIMITS);
  for (let i = 0; i < STARTING_LIMITS.d1Calls; i++) budget.spendQuery();
  assert.throws(() => budget.spendQuery(), state('budget'));
  assert.equal(budget.canRead(16385), false, 'a page read is capped by pageBytes');
  assert.equal(budget.canRead(20000, 'object'), true, 'a whole small object only by the remaining bytes');
  budget.spendRead(20000, 'object'); budget.spendRead(16384); budget.spendRead(16384);
  assert.equal(budget.canRead(1), true);
  assert.equal(budget.canRead(65536 - 20000 - 2 * 16384 + 1), false, 'total R2 bytes stay within the request allowance');
});

test('reads current once per request and uses one D1 call for it', async () => {
  const { env } = buildFixture();
  const session = await ReadSession.open(env, roomy);
  assert.equal(session.release.id, 'rel-2');
  assert.equal(session.budget.usage().d1Calls, 1);
  assert.equal(session.release.schema_versions.reader_scheme_version, undefined);
});

test('Study accepts the pinned optional reader catalogue and rejects an unsupported version', async () => {
  const fixture = buildFixture();
  for (const [release, version] of [['readable', 'nrsva/1'], ['unsupported', 'unknown/1']]) {
    fixture.db.sqlite.prepare('INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?)').run(release, 'm', 'r',
      JSON.stringify({ evidence_records: '1', reader_scheme_version: version }), 'c', 'q', 's');
  }
  fixture.select('readable');
  const session = await ReadSession.open(fixture.env, roomy);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS.reader_scheme_version, ['nrsva/1']);
  assert.equal(session.release.schema_versions.reader_scheme_version, 'nrsva/1');
  fixture.select('unsupported', 'readable');
  await assert.rejects(ReadSession.open(fixture.env, roomy), state('incompatible_release'));
});

test('no selection or an incompatible release is unavailability, never the previous release', async () => {
  const fixture = buildFixture();
  fixture.select(null);
  await assert.rejects(ReadSession.open(fixture.env, roomy), state('no_current_release'));
  const other = buildFixture();
  other.db.sqlite.exec(`INSERT INTO releases VALUES ('rel-3','m','r','{"evidence_records":"2"}','c','q','s')`);
  other.select('rel-3', 'rel-2');
  await assert.rejects(ReadSession.open(other.env, roomy), state('incompatible_release'));
});

test('two releases: reads are scoped to current release membership only', async () => {
  const fixture = buildFixture();
  let session = await ReadSession.open(fixture.env, roomy);
  let spans = await session.query('spans', { ids: ['a-u1', 'a-old', 'b-1'] });
  assert.deepEqual(spans.rows.map(r => r.id), ['a-u1', 'b-1'], 'old wording is not substituted into current reads');
  fixture.select('rel-1', null);
  session = await ReadSession.open(fixture.env, roomy);
  spans = await session.query('spans', { ids: ['a-u1', 'a-old'] });
  assert.deepEqual(spans.rows.map(r => [r.id, r.exact_text]), [['a-old', 'OLD wording']]);
});

test('a repeated passage avoids D1 evidence reads after checking the current release', async () => {
  const { env } = buildPassageFixture();
  const input = { units: ['Gen.1.1', 'Gen.1.2'], sources: [HEB] };
  const first = await ReadSession.open(env, roomy);
  const result = await first.query('unit_spans', input);
  assert.equal(first.budget.usage().d1Calls, 2);
  assert.equal(result.rows.length, 2);
  const expected = structuredClone(result);
  result.rows[0].label = 'caller mutation';

  const next = await ReadSession.open(env, { ...roomy, d1Calls: 1 });
  assert.deepEqual(await next.query('unit_spans', input), expected);
  assert.equal(next.budget.usage().d1Calls, 1);
  assert.deepEqual(await next.query('unit_spans', input), expected);
  assert.equal(next.budget.usage().d1Calls, 1);

  const smallerPage = await ReadSession.open(env, { ...roomy, rowsPerQuery: 1 });
  const firstPage = await smallerPage.query('unit_spans', input);
  assert.equal(firstPage.more, true);
  assert.deepEqual(firstPage.rows.map(row => row.id), [expected.rows[0].id]);
  assert.equal(smallerPage.budget.usage().d1Calls, 2);
});

test('query reuse is scoped to the selected release and its database binding', async () => {
  const fixture = buildFixture();
  const input = { ids: ['a-u1', 'a-old'] };
  const first = await ReadSession.open(fixture.env, roomy);
  assert.deepEqual((await first.query('spans', input)).rows.map(r => r.id), ['a-u1']);

  const other = await ReadSession.open(buildFixture().env, roomy);
  assert.deepEqual((await other.query('spans', input)).rows.map(r => r.id), ['a-u1']);
  assert.equal(other.budget.usage().d1Calls, 2);

  fixture.select('rel-1', 'rel-2');
  const current = await ReadSession.open(fixture.env, roomy);
  assert.deepEqual((await current.query('spans', input)).rows.map(r => r.id), ['a-old']);
  assert.equal(current.budget.usage().d1Calls, 2);
  assert.deepEqual((await first.query('spans', input)).rows.map(r => r.id), ['a-u1']);
});

test('passage lookups seek requested verse units and exact body artifacts', async () => {
  const { db, env } = buildPassageFixture();
  const session = await ReadSession.open(env, roomy);
  const input = { units: ['Gen.1.2', 'Gen.2.1', 'Mat.1.1', 'Gen.2.999'], sources: [HEB] };
  const spans = await session.query('unit_spans', input);
  assert.deepEqual(spans.rows.map(row => row.unit_id), ['Gen.1.2', 'Gen.2.1']);
  assert.deepEqual(spans.rows.map(row => JSON.parse(String(row.body_artifacts_json)).map((a: { id: string }) => a.id)),
    [['evidence:heb1:body'], ['evidence:heb2:body']]);
  const presence = await session.query('unit_presence', input);
  assert.equal(presence.rows.length, 1);
  assert.deepEqual(String(presence.rows[0].units).split(',').sort(), ['Gen.1.2', 'Gen.2.1']);

  for (const name of ['unit_presence', 'unit_spans'] as const) {
    const query = QUERIES[name];
    const args = [session.release.id, ...query.params(input), 20] as (string | number | null)[];
    const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...args).map(row => String(row.detail));
    assert.ok(plan.some(detail => detail.includes('SEARCH n USING INDEX native_spans_verse_unit')), plan.join('\n'));
    if (name === 'unit_spans')
      assert.ok(plan.some(detail => /SEARCH a USING INDEX .*\(id=\?\)/.test(detail)), plan.join('\n'));
  }
});

test('invalid references return nothing rather than another source', async () => {
  const session = await ReadSession.open(buildFixture().env, roomy);
  const spans = await session.query('spans', { ids: ['missing-span'] });
  assert.deepEqual(spans.rows, []);
  await assert.rejects(session.query('spans', { ids: [] }), state('invalid_request'));
  await assert.rejects(session.query('spans', { ids: ['x', 'x'] }), state('invalid_request'));
  await assert.rejects(session.query('spans', { ids: ['\uD800'] }), state('invalid_request'));
});

test('relationship endpoints, counts, coverage, packages and statement go through membership', async () => {
  const session = await ReadSession.open(buildFixture().env, roomy);
  const rel = await session.query('relationships', { span_id: 'a-u1' });
  const members = rel.rows.map(r => [r.role, r.ordinal, r.span_id, r.endpoint_selected, r.correspondence]);
  assert.deepEqual(members, [['from', 0, 'a-u1', 1, 'partial'], ['to', 0, 'a-old', 0, 'partial'], ['to', 1, null, null, 'missing']]);
  assert.equal(rel.rows[1].endpoint_label, null, 'unselected endpoint data is not returned');
  assert.deepEqual((await session.query('relationship_counts', { span_id: 'a-u1' })).rows.map(r => ({ ...r })), [{ kind: 'parallel', count: 1 }]);
  const coverage = await session.query('coverage', { source_revision_ids: [A, B] });
  assert.ok(coverage.rows.every(r => ['syn-src-1', 'syn-src-2', 'syn-src-b', 'syn-word-1'].includes(String(r.output_id))));
  assert.ok(coverage.rows.some(r => r.state === 'partial' && r.limitation === 'synthetic partial extent'));
  assert.deepEqual((await session.query('packages', { subject: 'synthetic-subject' })).rows.map(r => r.id), ['pkg-1']);
  const statement = (await session.query('statement', {})).rows;
  assert.deepEqual(Object.keys(statement[0]).sort(), ['id', 'name', 'scripture_basis_json', 'version']);
  assert.equal(JSON.stringify(statement).includes('private:approval-ref'), false);
});

test('literary overlap and row limits page deterministically', async () => {
  const session = await ReadSession.open(buildFixture().env, { ...roomy, rowsPerQuery: 1 });
  const first = await session.query('literary_overlap', { source_revision_id: A, kinds: ['literary_unit'], start: 0, end: 10 });
  assert.equal(first.more, true);
  const last = first.rows[0];
  const second = await session.query('literary_overlap', { source_revision_id: A, kinds: ['literary_unit'], start: 0, end: 10,
    after: [last.start_order as number, last.span_id as string, last.segment_ordinal as number] });
  assert.deepEqual([...first.rows, ...second.rows].map(r => [r.span_id, r.segment_ordinal]), [['a-unit', 0], ['a-unit', 1]]);
  assert.equal(second.more, false);
});

test('raw SQL, unknown queries and mutations are rejected; budget stops further queries', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, { ...roomy, d1Calls: 2 });
  // @ts-expect-error a host string is not an allowlisted query name
  await assert.rejects(session.query('DELETE FROM release_selection', {}), state('invalid_request'));
  // @ts-expect-error prototype keys are not queries
  await assert.rejects(session.query('constructor', {}), state('invalid_request'));
  for (const [name, q] of Object.entries(QUERIES)) {
    assert.match(q.sql, /^\s*(SELECT|WITH)\b/, name);
    assert.doesNotMatch(q.sql, /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|ATTACH|PRAGMA|maintenance_\w+|admissions|dependencies_json|owner_approval_ref)\b|;/i, name);
    assert.match(q.sql, /release_outputs \w+ ON \w+\.output_id = \w+\.output_id AND \w+\.release_id = \?1|ro\.release_id = \?1/, name);
  }
  await session.query('spans', { ids: ['a-u1'] });
  await assert.rejects(session.query('spans', { ids: ['a-u2'] }), state('budget'));
  assert.equal(fixture.db.sqlite.prepare('SELECT current_release_id FROM release_selection').get()?.current_release_id, 'rel-2');
});

test('a provider failure is a temporary failure, not an empty result', async () => {
  const fixture = buildFixture();
  const session = await ReadSession.open(fixture.env, roomy);
  fixture.db.sqlite.exec('DROP TABLE study_packages');
  await assert.rejects(session.query('packages', { subject: 'synthetic-subject' }), state('temporary_failure'));
});

test('R30-6: a release declaring index_manifest 2 opens; one declaring version 1 is incompatible', async () => {
  for (const [version, ok] of [['2', true], ['1', false]] as const) {
    const fixture = buildFixture();
    fixture.db.sqlite.exec(`INSERT INTO releases VALUES ('rel-v${version}','m','r','{"evidence_records":"1","native_reference":"1","index_manifest":"${version}"}','c','q','s')`);
    fixture.select(`rel-v${version}`, 'rel-2');
    if (ok) assert.equal((await ReadSession.open(fixture.env, roomy)).release.schema_versions.index_manifest, '2');
    else await assert.rejects(ReadSession.open(fixture.env, roomy), state('incompatible_release'));
  }
});
