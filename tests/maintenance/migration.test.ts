import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync, readFileSync} from 'node:fs';
import test from 'node:test';

const dir = new URL('../../schemas/migrations/', import.meta.url);
const apply = (db: DatabaseSync, name: string) =>
  db.exec(readFileSync(new URL(name, dir), 'utf8'));
const names = [
  '0001_evidence.sql',
  '0002_span_navigation.sql',
  '0003_maintenance.sql',
  '0004_job_results.sql',
  '0005_reader_references.sql',
  '0006_verse_unit_index.sql',
];
const digest = 'a'.repeat(64);
const task = (id: string, kind: string) => [
  id,
  'owner',
  id,
  'Instruction',
  JSON.stringify({kind}),
  digest,
  1,
  'completed',
  null,
  null,
  null,
  null,
  '{}',
];
const insert =
  'INSERT INTO maintenance_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

test('migration 0007 keeps existing tasks, jobs, index and triggers and accepts the acquire and release kinds', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of names) apply(db, name);
  db.prepare(insert).run(...task('t1', 'prepare'));
  db.prepare(
    `INSERT INTO maintenance_jobs VALUES ('t1', 1, 'acquire', 1, 'acquire', '${digest}', 'run-1', 'succeeded', NULL, NULL, NULL)`,
  ).run();
  assert.throws(
    () => db.prepare(insert).run(...task('t2', 'acquire')),
    /CHECK constraint failed/,
  );

  // D1 applies a migration file as one transaction; the deferred foreign-key check runs at its commit.
  db.exec('BEGIN');
  apply(db, '0007_task_kinds_acquire_release.sql');
  db.exec('COMMIT');

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM maintenance_tasks WHERE id = 't1'")
      .get()?.n,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM maintenance_jobs WHERE task_id = 't1'",
      )
      .get()?.n,
    1,
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.prepare(insert).run(...task('t2', 'acquire'));
  db.prepare(insert).run(...task('t3', 'release'));
  assert.throws(
    () => db.prepare(insert).run(...task('t4', 'nonsense')),
    /CHECK constraint failed/,
  );
  // The retained guards still fire.
  assert.throws(
    () => db.prepare("DELETE FROM maintenance_tasks WHERE id = 't1'").run(),
    /Task records are retained/,
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE maintenance_tasks SET revision = 5 WHERE id = 't3'")
        .run(),
    /Finished task is immutable/,
  );
  const objects = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE tbl_name = 'maintenance_tasks' AND type IN ('index','trigger') ORDER BY name",
    )
    .all()
    .map(row => row.name);
  assert.ok(
    objects.includes('maintenance_tasks_state') &&
      objects.includes('maintenance_task_no_delete'),
  );
  // A child row still points at the rebuilt table.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO maintenance_jobs VALUES ('missing', 1, 'acquire', 1, 'acquire', '${digest}', 'run-2', 'succeeded', NULL, NULL, NULL)`,
        )
        .run(),
    /FOREIGN KEY/,
  );
});

test('migration 0016 drops the job checkpoint column and keeps the job rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const before = readdirSync(dir)
    .filter(file => file.endsWith('.sql') && file < '0016')
    .sort();
  for (const name of before) apply(db, name);
  db.prepare(insert).run(...task('t1', 'prepare'));
  db.prepare(
    `INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, checkpoint_ref)
     VALUES ('t1', 1, 'u1', 1, 'prepare', '${digest}', 'run-1', 'succeeded', 'ck-1@${digest}')`,
  ).run();
  apply(db, '0016_drop_job_checkpoint.sql');
  const columns = db
    .prepare('PRAGMA table_info(maintenance_jobs)')
    .all()
    .map(row => row.name);
  assert.ok(!columns.includes('checkpoint_ref'));
  assert.equal(
    db.prepare("SELECT state FROM maintenance_jobs WHERE task_id = 't1'").get()
      ?.state,
    'succeeded',
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
