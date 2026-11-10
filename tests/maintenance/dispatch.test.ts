import test from 'node:test';
import assert from 'node:assert/strict';
import { localD1 } from './d1.ts';
import { requestTask, controlTask, taskReport, type TaskRow } from '../../services/maintenance/control/src/tasks.ts';
import { acceptReceipt, dispatchUnit, type UnitPlan, type WorkflowTransport } from '../../services/maintenance/control/src/dispatch.ts';
import type { JobInput } from '../../services/maintenance/control/src/contracts.ts';

const owner = 'owner@example.invalid';
const commit = 'f'.repeat(40);
const unit: UnitPlan = { unit_id: 'gen-1', kind: 'prepare', manifest_revision: 'manifest-1', recipe_revision: 'recipe-1', native_extent: { books: ['GEN'] } };

async function setup() {
  const db = localD1();
  const created = await requestTask(db, owner, { request_key: 'p1', instruction: 'Prepare Genesis', kind: 'prepare',
    inputs: [{ kind: 'acquisition', id: 'route-1' }], extent: { books: ['GEN'] }, capabilities: ['source_text'],
    decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] });
  assert.ok(created.status === 'created');
  return { db, task: created.task };
}
function transport(runs: string[] = ['run-1', 'run-2']): WorkflowTransport & { sent: JobInput[] } {
  const sent: JobInput[] = [];
  return { sent, async dispatch(input) { sent.push(input); const run = runs.shift(); if (!run) throw new Error('timeout'); return { run_id: run }; } };
}
function result(task: TaskRow, overrides: Record<string, unknown> = {}) {
  return { contract_version: 'maintenance-job/1', task_id: task.id, task_revision: 1, unit_id: 'gen-1', attempt: 1, basis_digest: task.basis_digest,
    run_id: 'run-1', completed_extent: { books: ['GEN'] }, remaining_extent: {}, output_refs: [{ artifact_id: 'out-1', sha256: 'c'.repeat(64), byte_count: 9 }],
    coverage_refs: [], checkpoint_ref: null, quality_receipt_ref: null, state: 'succeeded', diagnostics: [], ...overrides };
}

test('quality jobs cannot dispatch without a required capability', async () => {
  const { db, task } = await setup();
  const sent = transport();
  const quality: UnitPlan = { ...unit, kind: 'quality', required_capabilities: [] };
  await assert.rejects(() => dispatchUnit(db, sent, task.id, 1, quality),
    /Quality job must require at least one capability/);
  assert.equal(sent.sent.length, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get()?.n, 0);
  assert.equal((await taskReport(db, owner, task.id))?.state, 'queued');
  const allowed = await dispatchUnit(db, sent, task.id, 1,
    { ...quality, required_capabilities: ['source_text'] });
  assert.equal(allowed.status, 'dispatched');
});

test('intent is saved before dispatch and a repeated dispatch never creates a duplicate run', async () => {
  const { db, task } = await setup();
  const wire = transport();
  const first = await dispatchUnit(db, wire, task.id, 1, unit);
  assert.deepEqual(first, { status: 'dispatched', run_id: 'run-1', attempt: 1 });
  assert.equal(wire.sent[0].task_id, task.id);
  assert.deepEqual(Object.keys(wire.sent[0]).filter(key => /script|branch|url|path/i.test(key)), []);
  const report = await taskReport(db, owner, task.id);
  assert.equal(report?.state, 'running');
  const again = await dispatchUnit(db, wire, task.id, 2, unit);
  assert.equal(again.status, 'existing');
  assert.equal(wire.sent.length, 1);
  assert.equal((await dispatchUnit(db, wire, task.id, 1, unit)).status, 'not_dispatchable');
});

test('an unconfirmed dispatch keeps its intent for reconciliation instead of re-sending', async () => {
  const { db, task } = await setup();
  const wire = transport([]);
  assert.equal((await dispatchUnit(db, wire, task.id, 1, unit)).status, 'uncertain');
  assert.equal((await dispatchUnit(db, wire, task.id, 1, unit)).status, 'existing');
  assert.equal(wire.sent.length, 1);
  assert.equal((await acceptReceipt(db, result(task), commit, commit)).status, 'rejected');
});

test('receipts must match revision, unit, attempt, basis, run and commit; duplicates reuse the outcome', async () => {
  const { db, task } = await setup();
  await dispatchUnit(db, transport(), task.id, 1, unit);
  for (const [bad, reported] of [[{ run_id: 'run-x' }, commit], [{ attempt: 2 }, commit], [{ task_revision: 2 }, commit],
    [{ basis_digest: 'e'.repeat(64) }, commit], [{}, 'e'.repeat(40)], [{ state: 'promoted' }, commit]] as const)
    assert.equal((await acceptReceipt(db, result(task, bad), reported, commit)).status, 'rejected', JSON.stringify(bad));
  const checkpoint = await acceptReceipt(db, result(task, { state: 'checkpointed', remaining_extent: { chapters: [2] },
    checkpoint_ref: { artifact_id: 'ck-1', sha256: 'd'.repeat(64), byte_count: 4 } }), commit, commit);
  assert.deepEqual(checkpoint, { status: 'accepted', eligible: false, state: 'checkpointed' });
  const done = await acceptReceipt(db, result(task), commit, commit);
  assert.deepEqual(done, { status: 'accepted', eligible: true, state: 'succeeded' });
  assert.deepEqual(await acceptReceipt(db, result(task), commit, commit), { status: 'duplicate', eligible: true, state: 'succeeded' });
  assert.equal((await acceptReceipt(db, result(task, { completed_extent: {} }), commit, commit)).status, 'rejected');
  const report = await taskReport(db, owner, task.id);
  assert.equal(report?.jobs[0].checkpoint_ref, `ck-1@${'d'.repeat(64)}`);
  assert.equal(report?.data_current, false);
});

test('late results for cancelled work are recorded but never eligible', async () => {
  const { db, task } = await setup();
  await dispatchUnit(db, transport(), task.id, 1, unit);
  assert.equal((await controlTask(db, owner, task.id, 2, 'cancel')).status, 'ok');
  assert.equal((await dispatchUnit(db, transport(), task.id, 3, { ...unit, unit_id: 'gen-2' })).status, 'not_dispatchable');
  assert.deepEqual(await acceptReceipt(db, result(task), commit, commit), { status: 'accepted', eligible: false, state: 'cancelled' });
  assert.deepEqual(await acceptReceipt(db, result(task), commit, commit), { status: 'duplicate', eligible: false, state: 'cancelled' });
});

test('paused work keeps arriving checkpoints but dispatches nothing new', async () => {
  const { db, task } = await setup();
  await dispatchUnit(db, transport(), task.id, 1, unit);
  assert.equal((await controlTask(db, owner, task.id, 2, 'pause')).status, 'ok');
  assert.equal((await dispatchUnit(db, transport(), task.id, 3, { ...unit, unit_id: 'gen-2' })).status, 'not_dispatchable');
  const kept = await acceptReceipt(db, result(task, { state: 'checkpointed', checkpoint_ref: { artifact_id: 'ck-2', sha256: 'd'.repeat(64), byte_count: 4 } }), commit, commit);
  assert.equal(kept.status, 'accepted');
});

test('a run started while the task was cancelled is reported as orphaned, not dispatched', async () => {
  const { db, task } = await setup();
  const racing: WorkflowTransport = { async dispatch() {
    assert.equal((await controlTask(db, owner, task.id, 1, 'cancel')).status, 'ok');
    return { run_id: 'run-late' };
  } };
  const outcome = await dispatchUnit(db, racing, task.id, 1, unit);
  assert.equal(outcome.status, 'orphaned');
  assert.ok(outcome.status === 'orphaned' && outcome.run_id === 'run-late');
  assert.equal((await taskReport(db, owner, task.id))?.state, 'cancelled');
});

test('a cancel that lands while a success receipt is being recorded makes it ineligible', async () => {
  const { db, task } = await setup();
  await dispatchUnit(db, transport(), task.id, 1, unit);
  const racing = { ...db, prepare(sql: string) {
    if (sql.includes('SET\n      state = CASE')) db.sqlite.exec(`UPDATE maintenance_tasks SET state = 'cancelled', revision = revision + 1 WHERE id = '${task.id}'`);
    return db.prepare(sql);
  } };
  assert.deepEqual(await acceptReceipt(racing, result(task), commit, commit), { status: 'accepted', eligible: false, state: 'cancelled' });
});

test('a run started while the task was superseded is reported as orphaned', async () => {
  const { db, task } = await setup();
  const racing: WorkflowTransport = { async dispatch() {
    const next = await requestTask(db, owner, { request_key: 'p2', instruction: 'Prepare Genesis and Exodus', kind: 'prepare',
      inputs: [{ kind: 'acquisition', id: 'route-1' }], extent: { books: ['GEN', 'EXO'] }, capabilities: ['source_text'],
      decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }], supersedes: task.id });
    assert.equal(next.status, 'created');
    return { run_id: 'run-late' };
  } };
  assert.equal((await dispatchUnit(db, racing, task.id, 1, unit)).status, 'orphaned');
  assert.equal((await taskReport(db, owner, task.id))?.state, 'superseded');
});
