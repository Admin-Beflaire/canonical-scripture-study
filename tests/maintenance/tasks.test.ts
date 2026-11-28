import test from 'node:test';
import assert from 'node:assert/strict';
import {localD1} from './d1.ts';
import {
  controlTask,
  listTasks,
  normalizeScope,
  requestTask,
  taskReport,
  PAGE_SIZE,
  type Step,
  type TaskRequest,
} from '../../services/maintenance/control/src/tasks.ts';

const owner = 'owner@example.invalid';
const admitted = (
  db: ReturnType<typeof localD1>,
  id = 'src-rev-1',
  eligible = 1,
) => {
  db.sqlite
    .exec(`INSERT INTO source_nodes VALUES ('w-${id}','work',NULL,'Work','Attribution','synthetic','{}'),
    ('e-${id}','edition','w-${id}','Edition','Attribution','synthetic','{}'),
    ('r-${id}','representation','e-${id}','Representation','Attribution','synthetic','{}'),
    ('${id}','source_revision','r-${id}','Revision','Attribution','synthetic','{}')`);
  db.sqlite.exec(
    `INSERT INTO admissions VALUES ('adm-${id}','${id}','text','synthetic terms','["study"]','[]','[]',${eligible},'not_allowed')`,
  );
};
const prepare = (extra: Partial<TaskRequest> = {}): TaskRequest => ({
  request_key: 'prep-1',
  instruction: 'Prepare Genesis text',
  steps: ['build'],
  inputs: [{kind: 'source_revision', id: 'src-rev-1'}],
  extent: {books: ['GEN']},
  capabilities: ['source_text'],
  constraints: {recipe: 'r1'},
  ...extra,
});

/** Insert job rows for a task: unit id, run id and state each. */
function insertJobs(
  db: ReturnType<typeof localD1>,
  taskId: string,
  jobs: [unit: string, run: string | null, state: string][],
) {
  const statement = db.sqlite.prepare(
    `INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state)
     VALUES (?, 1, ?, 1, 'prepare', ?, ?, ?)`,
  );
  for (const [unit, run, state] of jobs)
    statement.run(taskId, unit, 'a'.repeat(64), run, state);
}

/** A local database with one admitted task that already has the given job rows. */
async function taskWithJobs(
  jobs: [unit: string, run: string | null, state: string][],
) {
  const db = localD1();
  admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  insertJobs(db, created.task.id, jobs);
  return {db, id: created.task.id};
}

const STEP_SETS: Step[][] = [
  ['fetch'],
  ['build'],
  ['select'],
  ['fetch', 'build'],
  ['build', 'select'],
  ['fetch', 'build', 'select'],
  ['remove'],
  ['rollback'],
  ['validate_restore'],
];
const request = (steps: Step[], change: Partial<TaskRequest> = {}) => {
  const builds = steps.includes('build');
  return {
    request_key: 'k',
    instruction: 'x',
    steps,
    inputs: [
      steps.includes('remove')
        ? {kind: 'source_revision' as const, id: 'src-rev-1'}
        : {kind: 'artifact' as const, id: 'a1'},
    ],
    extent: {units: ['u1']},
    capabilities: builds ? ['source_text'] : [],
    constraints: {
      ...(steps.includes('fetch') ? {fetch_recipe: 'f1'} : {}),
      ...(builds ? {recipe: 'r1'} : {}),
      ...(steps.includes('select') && !builds ? {candidate: 'task-1'} : {}),
    },
    ...change,
  } satisfies TaskRequest;
};

test('every step list normalizes, and missing information is named instead of guessed', () => {
  for (const steps of STEP_SETS)
    assert.deepEqual(normalizeScope(request(steps)).missing, [], `${steps}`);
  const statement = {
    kind: 'statement' as const,
    ref: 'owner-decision:9',
    name: 'Character of God',
    version: '1.0',
  };
  assert.deepEqual(
    normalizeScope(request(['build', 'select'], {decision_refs: [statement]}))
      .missing,
    [],
  );
  // Nothing is mandatory, but the steps must be real, once each and in order.
  for (const steps of [
    [],
    ['clean'],
    ['select', 'build'],
    ['build', 'build'],
    ['remove', 'build'],
    ['rollback', 'validate_restore'],
  ])
    assert.ok(
      normalizeScope(request(steps as Step[])).missing[0].startsWith('steps:'),
      `${steps}`,
    );
  const {missing} = normalizeScope({
    request_key: 'k',
    instruction: 'Prepare something',
    steps: ['build'],
  });
  assert.equal(missing.length, 4);
  // A task that builds nothing names no capabilities and a fetch names its recipe; a select
  // without a build names the build it makes current, and a build never does.
  const named = (steps: Step[], change: Partial<TaskRequest>, text: string) =>
    assert.ok(
      normalizeScope(request(steps, change)).missing.some(item =>
        item.includes(text),
      ),
      `${steps} ${text}`,
    );
  named(['fetch'], {capabilities: ['source_text']}, 'capabilities');
  named(['fetch'], {constraints: {}}, 'fetch_recipe');
  named(['build'], {constraints: {}}, 'constraints.recipe');
  named(['select'], {constraints: {}}, 'candidate');
  named(
    ['build', 'select'],
    {constraints: {recipe: 'r1', candidate: 'task-1'}},
    'candidate',
  );
  named(
    ['build', 'select'],
    {decision_refs: [statement, {...statement, ref: 'o:2'}]},
    'statement',
  );
  named(['fetch'], {decision_refs: [statement]}, 'statement');
  const a = normalizeScope(prepare({capabilities: ['b', 'a', 'a']})).scope,
    b = normalizeScope(prepare({capabilities: ['a', 'b']})).scope;
  assert.deepEqual(a, b);
});

test('admission is required explicitly; an eligible admission or owner decision reference satisfies it', async () => {
  const db = localD1();
  const blocked = await requestTask(db, owner, prepare());
  assert.equal(blocked.status, 'needs_information');
  admitted(db, 'src-rev-2', 0);
  const ineligible = await requestTask(
    db,
    owner,
    prepare({
      request_key: 'k2',
      inputs: [{kind: 'source_revision', id: 'src-rev-2'}],
    }),
  );
  assert.equal(ineligible.status, 'needs_information');
  const acquisition = await requestTask(
    db,
    owner,
    prepare({
      request_key: 'k3',
      inputs: [{kind: 'acquisition', id: 'route-1'}],
      decision_refs: [
        {kind: 'admission', ref: 'owner-decision:1', subject: 'route-1'},
      ],
    }),
  );
  assert.equal(acquisition.status, 'created');
  admitted(db);
  assert.equal((await requestTask(db, owner, prepare())).status, 'created');
  assert.equal(
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM maintenance_tasks').get()!.n,
    2,
  );
});

test('repeating a request key returns the same task; a changed instruction names the task it supersedes', async () => {
  const db = localD1();
  admitted(db);
  admitted(db, 'src-rev-3');
  const first = await requestTask(db, owner, prepare());
  assert.equal(first.status, 'created');
  const again = await requestTask(db, owner, prepare());
  assert.ok(
    again.status === 'existing' &&
      first.status === 'created' &&
      again.task.id === first.task.id,
  );
  assert.equal(
    (await requestTask(db, owner, prepare({extent: {books: ['EXO']}}))).status,
    'conflict',
  );
  assert.ok(first.status === 'created');
  // A new source revision for the same work: the old task is superseded only because it is named.
  const unnamed = await requestTask(
    db,
    owner,
    prepare({
      request_key: 'prep-2',
      inputs: [{kind: 'source_revision', id: 'src-rev-3'}],
    }),
  );
  assert.ok(unnamed.status === 'created' && unnamed.superseded.length === 0);
  const named = await requestTask(
    db,
    owner,
    prepare({
      request_key: 'prep-3',
      inputs: [{kind: 'source_revision', id: 'src-rev-3'}],
      extent: {books: ['GEN', 'EXO']},
      supersedes: first.task.id,
    }),
  );
  assert.ok(named.status === 'created');
  assert.deepEqual(named.superseded, [first.task.id]);
  assert.equal(
    (await taskReport(db, owner, first.task.id))?.state,
    'superseded',
  );
  assert.equal((await taskReport(db, owner, unnamed.task.id))?.state, 'queued');
  assert.equal(
    (
      await requestTask(
        db,
        owner,
        prepare({request_key: 'prep-4', supersedes: first.task.id}),
      )
    ).status,
    'needs_information',
  );
  assert.equal(
    await taskReport(db, 'someone@example.invalid', first.task.id),
    null,
  );
});

test('superseding is all or nothing under interleaving', async () => {
  const db = localD1();
  admitted(db);
  const old = await requestTask(db, owner, prepare());
  assert.ok(old.status === 'created');
  const replacement = prepare({
    request_key: 'prep-2',
    extent: {books: ['EXO']},
    supersedes: old.task.id,
  });
  // The named task changes after it was read: nothing is created and it stays open.
  const changing = {
    ...db,
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      db.sqlite.exec(
        `UPDATE maintenance_tasks SET state = 'paused', revision = 2 WHERE id = '${old.task.id}'`,
      );
      return db.batch(statements);
    },
  };
  assert.equal(
    (await requestTask(changing, owner, replacement)).status,
    'conflict',
  );
  assert.equal(
    db.sqlite.prepare('SELECT COUNT(*) AS n FROM maintenance_tasks').get()!.n,
    1,
  );
  assert.equal((await taskReport(db, owner, old.task.id))?.state, 'paused');
  // An identical concurrent request inserts first: this one supersedes nothing again.
  const first = await requestTask(db, owner, replacement);
  assert.ok(first.status === 'created' && first.superseded[0] === old.task.id);
  const raced = {
    ...db,
    prepare(sql: string) {
      if (sql.startsWith('SELECT * FROM maintenance_tasks WHERE requester'))
        return {
          ...db.prepare(sql),
          bind: () => ({first: async () => null}),
        } as never;
      return db.prepare(sql);
    },
  };
  const other = await requestTask(
    db,
    owner,
    prepare({request_key: 'prep-3', extent: {books: ['LEV']}}),
  );
  assert.ok(other.status === 'created');
  const again = await requestTask(raced, owner, {
    ...replacement,
    supersedes: other.task.id,
  });
  assert.equal(again.status, 'existing');
  assert.equal((await taskReport(db, owner, other.task.id))?.state, 'queued');
});

test('a cancel that loses the revision race changes no jobs', async () => {
  const {db, id} = await taskWithJobs([['u1', null, 'intended']]);
  // Another change lands between this caller's read and its write.
  const racing = {
    ...db,
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      db.sqlite.exec(
        `UPDATE maintenance_tasks SET state = 'paused', revision = 2 WHERE id = '${id}'`,
      );
      return db.batch(statements);
    },
  };
  assert.equal(
    (await controlTask(racing, owner, id, 1, 'cancel')).status,
    'conflict',
  );
  assert.equal(
    db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()!.state,
    'intended',
  );
});

test('pause, resume and cancel are revision guarded and keep truthful remaining scope', async () => {
  const {db, id} = await taskWithJobs([
    ['u-sent', 'run-7', 'running'],
    ['u-unsent', null, 'intended'],
  ]);
  assert.equal(
    (await controlTask(db, owner, id, 2, 'pause')).status,
    'conflict',
  );
  assert.equal(
    (await controlTask(db, owner, id, 1, 'resume')).status,
    'not_allowed',
  );
  const paused = await controlTask(db, owner, id, 1, 'pause');
  assert.ok(
    paused.status === 'ok' &&
      paused.task.state === 'paused' &&
      paused.task.revision === 2,
  );
  const resumed = await controlTask(db, owner, id, 2, 'resume');
  assert.ok(resumed.status === 'ok' && resumed.task.state === 'queued');
  const cancelled = await controlTask(db, owner, id, 3, 'cancel');
  assert.ok(cancelled.status === 'ok' && cancelled.task.state === 'cancelled');
  assert.deepEqual(
    JSON.parse(cancelled.task.outcome_json).cancel_requested_runs,
    ['run-7'],
  );
  const report = await taskReport(db, owner, id);
  assert.deepEqual(report?.remaining_extent, {books: ['GEN']});
  assert.equal(report?.data_current, false);
  assert.deepEqual(
    report?.jobs.map(job => [job.unit_id, job.state]),
    [
      ['u-sent', 'running'],
      ['u-unsent', 'cancelled'],
    ],
  );
  assert.equal(
    (await controlTask(db, owner, id, 4, 'resume')).status,
    'not_allowed',
  );
  assert.equal(
    (await controlTask(db, owner, 'task-missing', 1, 'pause')).status,
    'not_found',
  );
});

test('open and recent tasks are listed newest first in bounded pages', async () => {
  const db = localD1();
  admitted(db);
  for (let i = 0; i < PAGE_SIZE + 3; i++)
    await requestTask(db, owner, {
      request_key: `r-${i}`,
      instruction: `Rollback ${i} `.repeat(20),
      steps: ['rollback'],
    });
  const first = await listTasks(db, owner);
  assert.equal(first.tasks.length, PAGE_SIZE);
  assert.ok(first.tasks[0].instruction.length <= 120);
  assert.ok(first.cursor);
  const second = await listTasks(db, owner, first.cursor!);
  assert.equal(second.tasks.length, 3);
  assert.equal(second.cursor, null);
  assert.equal((await listTasks(db, 'other@example.invalid')).tasks.length, 0);
  await assert.rejects(listTasks(db, owner, '-1'));
});

const record = (extra: object = {}) => ({
  v: 1,
  tool: 'prepare',
  stage: 'building_output',
  outcome: 'failed',
  code: 'invalid_or_unavailable_output',
  error: 'OSError',
  ...extra,
});

test('task report shows the error record as stored and only a code for results from before records', async () => {
  const db = localD1();
  admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  const stored = record({
    http: 503,
    ids: {unit: 'u1'},
    message: 'Gen.3 line 1204, field morph: expected a morphology code',
  });
  const result = JSON.stringify({
    diagnostics: [
      {code: 'invalid_or_unavailable_output', message: JSON.stringify(stored)},
      {code: 'runner_error', message: 'OSError: private secret material'},
      {code: 'reader_boundary', message: '{"v":2,"unknown":"shape"}'},
      {code: 'constructor', message: 'secret'},
      {code: 'bad code with spaces', message: JSON.stringify(stored)},
    ],
  });
  db.sqlite
    .prepare(
      `INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, result_json)
    VALUES (?,1,'u1',1,'prepare',?,'run-1','failed',?)`,
    )
    .run(created.task.id, 'a'.repeat(64), result);
  const report = await taskReport(db, owner, created.task.id);
  const predates = 'This result predates error records; only its code is kept.';
  assert.deepEqual(report?.jobs[0].diagnostics, [
    {code: 'invalid_or_unavailable_output', record: stored},
    {code: 'runner_error', message: predates},
    {code: 'reader_boundary', message: predates},
    {code: 'constructor', message: predates},
  ]);
  assert.equal(
    JSON.stringify(report).includes('private secret material'),
    false,
  );
  assert.equal(
    await taskReport(db, 'other@example.invalid', created.task.id),
    null,
  );
});
