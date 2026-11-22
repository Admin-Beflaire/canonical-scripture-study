import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  OUTPUT_ROWS,
  tidyReleases,
} from '../../services/maintenance/control/src/cleanup.ts';
import {advance} from '../../services/maintenance/control/src/progress.ts';
import {
  validateRelease,
  type ObjectStore,
} from '../../services/maintenance/control/src/selection.ts';
import {localD1} from './d1.ts';

/** Release cleanup (Proposal M2): what a release or open task needs stays, the rest goes.
 *  Synthetic records only. */
const DIGEST = 'a'.repeat(64);
const SCOPE = JSON.stringify({kind: 'prepare'});
const OUTCOME = JSON.stringify({limitations: []});

/** A bucket that remembers what it holds and what was removed; `failing` makes a removal fail. */
function bucket(keys: string[] = [], failing = false) {
  const held = new Set(keys);
  const calls: string[][] = [];
  const store: ObjectStore & {held: Set<string>; calls: string[][]} = {
    held,
    calls,
    async list() {
      return {objects: [...held].map(key => ({key, size: 1}))};
    },
    async remove(removed) {
      if (failing) throw new Error('bucket unavailable');
      calls.push(removed);
      for (const key of removed) held.delete(key);
    },
  };
  return store;
}

/** A saved output with a span, its text, coverage and one stored artifact. */
function outputSaver(sql: ReturnType<typeof localD1>['sqlite']) {
  let counter = 0;
  const output = (id: string, text: string, kind = 'text') => {
    sql
      .prepare(
        `INSERT INTO prepared_outputs VALUES (?, ?, '["rev"]', 'm1', '{}', '{}', '{}')`,
      )
      .run(id, kind);
    const content = createHash('sha256').update(text).digest('hex');
    sql
      .prepare(`INSERT OR IGNORE INTO text_payloads VALUES (?, ?)`)
      .run(content, text);
    sql
      .prepare(
        `INSERT INTO native_spans VALUES (?, ?, 'rev', NULL, 'verse', 'v', ?, 'c/1', '[{"a":1}]', '{}', ?, '[]', 'preserved')`,
      )
      .run(`span-${id}`, id, ++counter, content);
    sql
      .prepare(
        `INSERT INTO coverage VALUES (?, 'rev', '{}', 'source_context', 'available', 'm1', NULL, '[]', NULL)`,
      )
      .run(id);
    sql
      .prepare(
        `INSERT INTO artifacts VALUES (?, 'rev', ?, ?, 10, 'application/json', ?)`,
      )
      .run(`artifact-${id}`, id, DIGEST, `prepared/${id}.json`);
    return id;
  };
  return output;
}

function world() {
  const db = localD1();
  const sql = db.sqlite;
  sql.exec(`
    INSERT INTO source_nodes VALUES ('w', 'work', NULL, 'w', 'a', 'o', '{}');
    INSERT INTO source_nodes VALUES ('e', 'edition', 'w', 'e', 'a', 'o', '{}');
    INSERT INTO source_nodes VALUES ('r', 'representation', 'e', 'r', 'a', 'o', '{}');
    INSERT INTO source_nodes VALUES ('rev', 'source_revision', 'r', 'rev', 'a', 'o', '{}');`);
  const output = outputSaver(sql);
  const release = (id: string, members: string[]) => {
    sql
      .prepare(`INSERT INTO releases VALUES (?, 'm', 'r', '{}', 'c', 'q', 's')`)
      .run(id);
    for (const member of members)
      sql.prepare(`INSERT INTO release_outputs VALUES (?, ?)`).run(id, member);
    return id;
  };
  const select = (current: string, previous: string | null = null) =>
    sql
      .prepare(
        `UPDATE release_selection SET current_release_id = ?, previous_release_id = ?`,
      )
      .run(current, previous);
  const task = (
    id: string,
    state: string,
    base: string | null,
    candidate: string | null,
  ) =>
    sql
      .prepare(
        `INSERT INTO maintenance_tasks VALUES (?, 'o', ?, 'i', ?, ?, 1, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(id, id, SCOPE, DIGEST, state, base, candidate, OUTCOME);
  const job = (taskId: string, state: string, refs: string[] = []) =>
    sql
      .prepare(
        `INSERT INTO maintenance_jobs VALUES (?, 1, ?, 1, 'prepare', ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        taskId,
        `unit-${taskId}`,
        DIGEST,
        state === 'intended' ? null : 'run-1',
        state,
        JSON.stringify({
          output_refs: refs.map(ref => ({
            artifact_id: `artifact-${ref}`,
            sha256: DIGEST,
            byte_count: 10,
          })),
        }),
      );
  const count = (table: string) =>
    (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;
  return {db, sql, output, release, select, task, job, count};
}

test('membership of releases nothing needs is removed; kept releases and release records stay', async () => {
  const w = world();
  const [a, b, c, d, e] = ['oa', 'ob', 'oc', 'od', 'oe'].map(id =>
    w.output(id, id),
  );
  w.release('release-old', [a]);
  w.release('release-previous', [a, b]);
  w.release('release-current', [b, c]);
  w.release('release-base', [c]);
  w.release('release-candidate', [d]);
  w.release('release-finished', [e]);
  w.select('release-current', 'release-previous');
  w.task('open', 'checked', 'release-base', 'release-candidate');
  w.task('done', 'completed', 'release-finished', 'release-finished');
  const done = await tidyReleases(w.db, bucket());
  assert.equal(done.memberships, 2); // release-old and release-finished
  const kept = w.sql
    .prepare(
      `SELECT DISTINCT release_id FROM release_outputs ORDER BY release_id`,
    )
    .all()
    .map(row => row.release_id);
  assert.deepEqual(kept, [
    'release-base',
    'release-candidate',
    'release-current',
    'release-previous',
  ]);
  assert.equal(w.count('releases'), 6);
});

test('saved outputs nothing kept uses are removed with their rows; shared text stays while used', async () => {
  const w = world();
  const kept = w.output('kept', 'shared text');
  w.output('orphan', 'shared text');
  w.output('lonely', 'only here');
  const opened = w.output('opened', 'open task text');
  w.output('statement', 'owner text', 'character_statement');
  w.release('release-current', [kept]);
  w.select('release-current');
  w.task('open', 'running', null, null);
  w.job('open', 'succeeded', [opened]);
  const done = await tidyReleases(w.db, bucket());
  assert.equal(done.outputs, 2);
  const left = w.sql
    .prepare(`SELECT id FROM prepared_outputs ORDER BY id`)
    .all()
    .map(row => row.id);
  assert.deepEqual(left, ['kept', 'opened', 'statement']);
  assert.equal(w.count('native_spans'), 3);
  assert.equal(w.count('coverage'), 3);
  assert.equal(w.count('artifacts'), 3);
  const payloads = w.sql
    .prepare(`SELECT exact_text FROM text_payloads ORDER BY exact_text`)
    .all()
    .map(row => row.exact_text);
  assert.deepEqual(payloads, ['open task text', 'owner text', 'shared text']);
});

test('the stored objects of a removed output are removed; others stay', async () => {
  const w = world();
  const kept = w.output('kept', 'kept text');
  w.output('gone', 'gone text');
  w.output('shared', 'shared text');
  // A kept output's record also names the removed output's object, so it must stay.
  w.sql
    .prepare(
      `INSERT INTO artifacts VALUES ('extra', 'rev', 'kept', ?, 10, 'application/json', 'prepared/shared.json')`,
    )
    .run(DIGEST);
  w.release('release-current', [kept]);
  w.select('release-current');
  // An acquisition record (no output) and a receipt are never removed.
  w.sql
    .prepare(
      `INSERT INTO artifacts VALUES ('original', 'rev', NULL, ?, 10, 'text/plain', 'sources/original.txt')`,
    )
    .run(DIGEST);
  w.sql
    .prepare(
      `INSERT INTO artifacts VALUES ('receipt', 'rev', 'gone', ?, 10, 'application/json', 'prepared/receipts/r.json')`,
    )
    .run(DIGEST);
  const store = bucket([
    'prepared/kept.json',
    'prepared/gone.json',
    'prepared/shared.json',
    'sources/original.txt',
    'prepared/receipts/r.json',
  ]);
  const done = await tidyReleases(w.db, store);
  assert.equal(done.outputs, 2);
  assert.deepEqual([...store.held].sort(), [
    'prepared/kept.json',
    'prepared/receipts/r.json',
    'prepared/shared.json',
    'sources/original.txt',
  ]);
  assert.deepEqual(store.calls.flat().sort(), ['prepared/gone.json']);
});

test('without a bucket, or when removing objects fails, the output stays and is tried again', async () => {
  const w = world();
  w.output('leftover', 'leftover');
  assert.equal((await tidyReleases(w.db)).outputs, 0);
  const failing = await tidyReleases(
    w.db,
    bucket(['prepared/leftover.json'], true),
  );
  assert.deepEqual([failing.outputs, failing.skipped], [0, 1]);
  assert.equal(w.count('prepared_outputs'), 1);
  assert.equal(w.count('artifacts'), 1);
  const store = bucket(['prepared/leftover.json']);
  assert.equal((await tidyReleases(w.db, store)).outputs, 1);
  assert.equal(store.held.size, 0);
  assert.equal(w.count('prepared_outputs'), 0);
});

test('nothing is removed from saved outputs while a job is unfinished', async () => {
  const w = world();
  w.output('half-saved', 'not reported yet');
  w.task('open', 'running', null, null);
  w.job('open', 'running');
  const done = await tidyReleases(w.db, bucket());
  assert.equal(done.outputs, 0);
  assert.equal(w.count('prepared_outputs'), 1);
});

test('an output another unused output points at is skipped, then removed on the next call', async () => {
  const w = world();
  w.output('first', 'first text');
  w.output('second', 'second text');
  // The second output's annotation points at the first output's span.
  w.sql
    .prepare(
      `INSERT INTO annotations VALUES ('note', 'second', 'rev', 'span-first', 'k', 'p', '{}', '{}')`,
    )
    .run();
  const store = bucket(['prepared/first.json', 'prepared/second.json']);
  const one = await tidyReleases(w.db, store);
  // The first output could not be removed, so its object is still there with its record.
  assert.deepEqual([...store.held], ['prepared/first.json']);
  assert.equal(w.count('prepared_outputs'), 1);
  assert.equal(w.count('artifacts'), 1);
  const two = await tidyReleases(w.db, store);
  assert.equal(one.outputs + two.outputs, 2);
  assert.equal(w.count('prepared_outputs'), 0);
  assert.equal(store.held.size, 0);
});

test('a cleanup that fails is reported and never throws', async () => {
  const w = world();
  w.sql.exec('DROP TABLE release_outputs');
  const done = await tidyReleases(w.db, bucket());
  assert.deepEqual(done, {memberships: 0, outputs: 0, skipped: 0});
});

test('a release is removed whole or not at all, also when a call reaches its limit', async () => {
  const w = world();
  w.sql.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
    INSERT INTO releases SELECT 'release-' || i, 'm', 'r', '{}', 'c', 'q', 's' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
    INSERT INTO prepared_outputs SELECT 'out-' || i, 'text', '["rev"]', 'm1', '{}', '{}', '{}' FROM n;
    INSERT INTO release_outputs SELECT r.id, o.id FROM releases r CROSS JOIN prepared_outputs o;`);
  const sizes = () =>
    w.sql
      .prepare(
        `SELECT r.id, (SELECT COUNT(*) FROM release_outputs ro WHERE ro.release_id = r.id) AS n FROM releases r`,
      )
      .all()
      .map(row => Number(row.n));
  const first = await tidyReleases(w.db, bucket());
  assert.ok(first.memberships > 0 && w.count('release_outputs') > 0); // The limit was reached.
  assert.ok(sizes().every(size => size === 0 || size === 500)); // No release is partly cleaned.
  while ((await tidyReleases(w.db, bucket())).memberships)
    assert.ok(sizes().every(size => size === 0 || size === 500));
  assert.equal(w.count('release_outputs'), 0);
});

test('a task that ends clears what it left behind, and the selection is unchanged', async () => {
  const w = world();
  const kept = w.output('kept', 'kept');
  w.output('leftover', 'leftover');
  w.release('release-old', [kept]);
  w.release('release-current', [kept]);
  w.select('release-current');
  w.task('ended', 'cancelled', 'release-old', null);
  const progress = await advance(w.db, null, 'ended', bucket());
  assert.equal(progress.state, 'cancelled');
  assert.equal(w.count('release_outputs'), 1);
  assert.equal(w.count('prepared_outputs'), 1);
  const selected = w.sql
    .prepare(`SELECT current_release_id AS c FROM release_selection`)
    .get() as {c: string};
  assert.equal(selected.c, 'release-current');
});

test('a release that becomes kept after it was listed keeps its membership', async () => {
  const w = world();
  const member = w.output('member', 'member');
  for (const id of ['release-task', 'release-selected', 'release-unused'])
    w.release(id, [member]);
  w.release('release-current', [member]);
  w.select('release-current');
  const batch = w.db.batch.bind(w.db);
  // Between listing the releases and deleting, an open task and a selection start using two of them.
  w.db.batch = async statements => {
    w.task('open', 'running', 'release-task', null);
    w.select('release-selected', 'release-current');
    return batch(statements);
  };
  await tidyReleases(w.db, bucket());
  const left = w.sql
    .prepare(
      `SELECT DISTINCT release_id FROM release_outputs ORDER BY release_id`,
    )
    .all()
    .map(row => row.release_id);
  assert.deepEqual(left, [
    'release-current',
    'release-selected',
    'release-task',
  ]);
});

test('a release whose membership was removed cannot be selected again', async () => {
  const w = world();
  const kept = w.output('kept', 'kept');
  w.release('release-old', [kept]);
  w.release('release-current', [kept]);
  w.select('release-current');
  await tidyReleases(w.db, bucket());
  const check = await validateRelease(w.db, new Map(), 'release-old');
  assert.ok(check.problems.some(problem => problem.includes('has no members')));
});

test('every table that holds rows for a saved output is cleared with it', () => {
  const w = world();
  const tables = w.sql
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map(row => String(row.name))
    .filter(name =>
      w.sql
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .some(column => column.name === 'output_id'),
    );
  assert.ok(tables.includes('native_spans'));
  // Membership is removed on its own (before outputs); a statement is never removed.
  for (const table of tables.filter(
    name => !['release_outputs', 'character_statements'].includes(name),
  ))
    assert.ok(
      OUTPUT_ROWS.some(sql => sql.startsWith(`DELETE FROM ${table} WHERE`)),
      `${table} has rows per saved output that cleanup does not remove; add it to OUTPUT_ROWS`,
    );
});
