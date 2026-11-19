import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { localD1 } from './d1.ts';
import { controlTask, listTasks, normalizeScope, requestTask, taskReport, PAGE_SIZE, TASK_KINDS, type TaskRequest } from '../../services/maintenance/control/src/tasks.ts';

const owner = 'owner@example.invalid';
const admitted = (db: ReturnType<typeof localD1>, id = 'src-rev-1', eligible = 1) => {
  db.sqlite.exec(`INSERT INTO source_nodes VALUES ('w-${id}','work',NULL,'Work','Attribution','synthetic','{}'),
    ('e-${id}','edition','w-${id}','Edition','Attribution','synthetic','{}'),
    ('r-${id}','representation','e-${id}','Representation','Attribution','synthetic','{}'),
    ('${id}','source_revision','r-${id}','Revision','Attribution','synthetic','{}')`);
  db.sqlite.exec(`INSERT INTO admissions VALUES ('adm-${id}','${id}','text','synthetic terms','["study"]','[]','[]',${eligible},'not_allowed')`);
};
const prepare = (extra: Partial<TaskRequest> = {}): TaskRequest => ({
  request_key: 'prep-1', instruction: 'Prepare Genesis text', kind: 'prepare',
  inputs: [{ kind: 'source_revision', id: 'src-rev-1' }], extent: { books: ['GEN'] }, capabilities: ['source_text'], ...extra,
});

test('every task kind normalizes, and missing information is named instead of guessed', () => {
  for (const kind of TASK_KINDS) {
    const { missing } = normalizeScope({ request_key: 'k', instruction: 'x', kind,
      inputs: [kind === 'remove' ? { kind: 'source_revision', id: 'src-rev-1' } : { kind: 'artifact', id: 'a1' }],
      extent: { units: ['u1'] }, capabilities: kind === 'acquire' ? [] : ['source_text'],
      constraints: kind === 'acquire' ? { recipe: 'r1' } : kind === 'release' ? { candidate: 'task-1' } : {},
      decision_refs: [{ kind: 'statement', ref: 'owner-decision:9', name: 'Character of God', version: '1.0' }] });
    assert.deepEqual(missing, [], kind);
  }
  const { missing } = normalizeScope({ request_key: 'k', instruction: 'Prepare something', kind: 'prepare' });
  assert.equal(missing.length, 3);
  // An acquire task names a recipe and no capabilities; a release names the build it releases.
  assert.equal(normalizeScope({ request_key: 'k', instruction: 'x', kind: 'acquire', inputs: [{ kind: 'acquisition', id: 'r' }],
    extent: { component: 'c' }, capabilities: ['source_text'] }).missing.length, 2);
  assert.ok(normalizeScope({ request_key: 'k', instruction: 'x', kind: 'release' }).missing[0].includes('candidate'));
  assert.ok(normalizeScope({ request_key: 'k', instruction: 'x', kind: 'incorporate_statement' }).missing[0].includes('statement'));
  const a = normalizeScope(prepare({ capabilities: ['b', 'a', 'a'] })).scope, b = normalizeScope(prepare({ capabilities: ['a', 'b'] })).scope;
  assert.deepEqual(a, b);
});

test('admission is required explicitly; an eligible admission or owner decision reference satisfies it', async () => {
  const db = localD1();
  const blocked = await requestTask(db, owner, prepare());
  assert.equal(blocked.status, 'needs_information');
  admitted(db, 'src-rev-2', 0);
  const ineligible = await requestTask(db, owner, prepare({ request_key: 'k2', inputs: [{ kind: 'source_revision', id: 'src-rev-2' }] }));
  assert.equal(ineligible.status, 'needs_information');
  const acquisition = await requestTask(db, owner, prepare({ request_key: 'k3', inputs: [{ kind: 'acquisition', id: 'route-1' }],
    decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] }));
  assert.equal(acquisition.status, 'created');
  admitted(db);
  assert.equal((await requestTask(db, owner, prepare())).status, 'created');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM maintenance_tasks').get()!.n, 2);
});

test('repeating a request key returns the same task; a changed instruction names the task it supersedes', async () => {
  const db = localD1(); admitted(db); admitted(db, 'src-rev-3');
  const first = await requestTask(db, owner, prepare());
  assert.equal(first.status, 'created');
  const again = await requestTask(db, owner, prepare());
  assert.ok(again.status === 'existing' && first.status === 'created' && again.task.id === first.task.id);
  assert.equal((await requestTask(db, owner, prepare({ extent: { books: ['EXO'] } }))).status, 'conflict');
  assert.ok(first.status === 'created');
  // A new source revision for the same work: the old task is superseded only because it is named.
  const unnamed = await requestTask(db, owner, prepare({ request_key: 'prep-2', inputs: [{ kind: 'source_revision', id: 'src-rev-3' }] }));
  assert.ok(unnamed.status === 'created' && unnamed.superseded.length === 0);
  const named = await requestTask(db, owner, prepare({ request_key: 'prep-3', inputs: [{ kind: 'source_revision', id: 'src-rev-3' }],
    extent: { books: ['GEN', 'EXO'] }, supersedes: first.task.id }));
  assert.ok(named.status === 'created');
  assert.deepEqual(named.superseded, [first.task.id]);
  assert.equal((await taskReport(db, owner, first.task.id))?.state, 'superseded');
  assert.equal((await taskReport(db, owner, unnamed.task.id))?.state, 'queued');
  assert.equal((await requestTask(db, owner, prepare({ request_key: 'prep-4', supersedes: first.task.id }))).status, 'needs_information');
  assert.equal(await taskReport(db, 'someone@example.invalid', first.task.id), null);
});

test('superseding is all or nothing under interleaving', async () => {
  const db = localD1(); admitted(db);
  const old = await requestTask(db, owner, prepare());
  assert.ok(old.status === 'created');
  const replacement = prepare({ request_key: 'prep-2', extent: { books: ['EXO'] }, supersedes: old.task.id });
  // The named task changes after it was read: nothing is created and it stays open.
  const changing = { ...db, batch: async (statements: Parameters<typeof db.batch>[0]) => {
    db.sqlite.exec(`UPDATE maintenance_tasks SET state = 'paused', revision = 2 WHERE id = '${old.task.id}'`);
    return db.batch(statements);
  } };
  assert.equal((await requestTask(changing, owner, replacement)).status, 'conflict');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM maintenance_tasks').get()!.n, 1);
  assert.equal((await taskReport(db, owner, old.task.id))?.state, 'paused');
  // An identical concurrent request inserts first: this one supersedes nothing again.
  const first = await requestTask(db, owner, replacement);
  assert.ok(first.status === 'created' && first.superseded[0] === old.task.id);
  const raced = { ...db, prepare(sql: string) {
    if (sql.startsWith('SELECT * FROM maintenance_tasks WHERE requester')) return { ...db.prepare(sql), bind: () => ({ first: async () => null }) } as never;
    return db.prepare(sql);
  } };
  const other = await requestTask(db, owner, prepare({ request_key: 'prep-3', extent: { books: ['LEV'] } }));
  assert.ok(other.status === 'created');
  const again = await requestTask(raced, owner, { ...replacement, supersedes: other.task.id });
  assert.equal(again.status, 'existing');
  assert.equal((await taskReport(db, owner, other.task.id))?.state, 'queued');
});

test('a cancel that loses the revision race changes no jobs', async () => {
  const db = localD1(); admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  const id = created.task.id;
  db.sqlite.exec(`INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, checkpoint_ref, result_ref) VALUES ('${id}',1,'u1',1,'prepare','${'a'.repeat(64)}',NULL,'intended',NULL,NULL)`);
  // Another change lands between this caller's read and its write.
  const racing = { ...db, batch: async (statements: Parameters<typeof db.batch>[0]) => {
    db.sqlite.exec(`UPDATE maintenance_tasks SET state = 'paused', revision = 2 WHERE id = '${id}'`);
    return db.batch(statements);
  } };
  assert.equal((await controlTask(racing, owner, id, 1, 'cancel')).status, 'conflict');
  assert.equal(db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()!.state, 'intended');
});

test('pause, resume and cancel are revision guarded and keep truthful remaining scope', async () => {
  const db = localD1(); admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  const id = created.task.id;
  db.sqlite.exec(`INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, checkpoint_ref, result_ref) VALUES ('${id}',1,'u-sent',1,'prepare','${'a'.repeat(64)}','run-7','running','ckpt-1',NULL),
    ('${id}',1,'u-unsent',1,'prepare','${'a'.repeat(64)}',NULL,'intended',NULL,NULL)`);
  assert.equal((await controlTask(db, owner, id, 2, 'pause')).status, 'conflict');
  assert.equal((await controlTask(db, owner, id, 1, 'resume')).status, 'not_allowed');
  const paused = await controlTask(db, owner, id, 1, 'pause');
  assert.ok(paused.status === 'ok' && paused.task.state === 'paused' && paused.task.revision === 2);
  const resumed = await controlTask(db, owner, id, 2, 'resume');
  assert.ok(resumed.status === 'ok' && resumed.task.state === 'queued');
  const cancelled = await controlTask(db, owner, id, 3, 'cancel');
  assert.ok(cancelled.status === 'ok' && cancelled.task.state === 'cancelled');
  assert.deepEqual(JSON.parse(cancelled.task.outcome_json).cancel_requested_runs, ['run-7']);
  const report = await taskReport(db, owner, id);
  assert.deepEqual(report?.remaining_extent, { books: ['GEN'] });
  assert.equal(report?.data_current, false);
  assert.deepEqual(report?.jobs.map(job => [job.unit_id, job.state, job.checkpoint_ref]), [['u-sent', 'running', 'ckpt-1'], ['u-unsent', 'cancelled', null]]);
  assert.equal((await controlTask(db, owner, id, 4, 'resume')).status, 'not_allowed');
  assert.equal((await controlTask(db, owner, 'task-missing', 1, 'pause')).status, 'not_found');
});

test('open and recent tasks are listed newest first in bounded pages', async () => {
  const db = localD1(); admitted(db);
  for (let i = 0; i < PAGE_SIZE + 3; i++)
    await requestTask(db, owner, { request_key: `r-${i}`, instruction: `Rollback ${i} `.repeat(20), kind: 'rollback' });
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

test('task report shows safe diagnostics and never exposes arbitrary saved exception text', async () => {
  const db = localD1(); admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  const result = JSON.stringify({ diagnostics: [
    { code: 'reader_boundary', message: 'Reader marker 1Ch.12.5 crosses the requested native unit boundary' },
    { code: 'provider_failure', message: 'Provider request failed with HTTP 429' },
    { code: 'provider_failure', message: 'Provider request failed with HTTP 429; internal detail' },
    { code: 'constructor', message: 'secret' },
    { code: 'quality_failed', message: 'Quality failure during saving_receipt; detail unavailable' },
    { code: 'transient_exhausted', message: 'Transient failure during saving_output; retries exhausted' },
    { code: 'runner_error', message: 'private secret material' },
    { code: 'reader_boundary', message: 'private secret material' },
  ] });
  db.sqlite.prepare(`INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, result_json)
    VALUES (?,1,'u1',1,'prepare',?,'run-1','failed',?)`).run(created.task.id, 'a'.repeat(64), result);
  const report = await taskReport(db, owner, created.task.id);
  assert.deepEqual(report?.jobs[0].diagnostics, [
    { code: 'reader_boundary', message: 'Reader marker 1Ch.12.5 crosses the requested native unit boundary' },
    { code: 'provider_failure', message: 'Provider request failed with HTTP 429' },
    { code: 'provider_failure', message: 'provider_failure' },
    { code: 'constructor', message: 'constructor' },
    { code: 'quality_failed', message: 'Quality failure during saving_receipt; detail unavailable' },
    { code: 'transient_exhausted', message: 'Transient failure during saving_output; retries exhausted' },
    { code: 'runner_error', message: 'The preparation runner encountered an unexpected error.' },
    { code: 'reader_boundary', message: 'reader_boundary' },
  ]);
  assert.equal(JSON.stringify(report).includes('private secret material'), false);
  assert.equal(await taskReport(db, 'other@example.invalid', created.task.id), null);
});

test('Python preparation diagnostics survive the Control report filter', async () => {
  const script = `import json
from css_preparation.provider import ProviderError, provider_diagnostic, quality_diagnostic, stage_diagnostic
from css_preparation.executor.checkpoints import UnitProgress
from css_preparation.prepare.records import ReaderBoundaryError
from css_preparation.runner.__main__ import _from_progress
job = json.load(open('tests/conformance/dp04-control-wire.v1.json'))['job_input']
stages = ['control_check','checkpoint_recovery','acquiring_input','building_output','validating_output','saving_output','verifying_output','saving_checkpoint']
out = []
for stage in stages:
    for code, message in [('invalid_or_unavailable_output', stage_diagnostic(stage)), ('transient_exhausted', stage_diagnostic(stage, transient=True)), ('provider_failure', provider_diagnostic(ProviderError('secret', status=503), stage))]:
        progress = UnitProgress('failed', {}, job['native_extent'], None, None, None, (code,), message)
        out.extend(_from_progress(job, '123', progress)['diagnostics'])
for stage in ['validating_candidate','saving_receipt','verifying_receipt','control_check']:
    if stage != 'control_check':
        out.append({'code': 'provider_failure', 'message': provider_diagnostic(ProviderError('secret', status=503), stage)})
    out.append({'code': 'quality_failed', 'message': quality_diagnostic(stage)})
out.append({'code': 'reader_boundary', 'message': str(ReaderBoundaryError('1Ch.12.5'))})
print(json.dumps(out))`;
  const env = { ...process.env, PYTHONPATH: ['packages/shared-python/src', 'services/maintenance/data-preparation/src', 'tests/python'].join(process.platform === 'win32' ? ';' : ':') };
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const diagnostics = JSON.parse(execFileSync(python, ['-c', script], { encoding: 'utf8', env })) as {code: string; message: string}[];
  const db = localD1(); admitted(db);
  const created = await requestTask(db, owner, prepare());
  assert.ok(created.status === 'created');
  db.sqlite.prepare(`INSERT INTO maintenance_jobs (task_id, task_revision, unit_id, attempt, kind, input_basis, run_id, state, result_json)
    VALUES (?,1,'u1',1,'prepare',?,'run-1','failed',?)`).run(created.task.id, 'a'.repeat(64), JSON.stringify({ diagnostics }));
  const report = await taskReport(db, owner, created.task.id);
  assert.deepEqual(report?.jobs[0].diagnostics, diagnostics);
});
