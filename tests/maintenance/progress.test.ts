import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localD1 } from './d1.ts';
import { fakeGitHub } from './github.ts';
import { GitHubActions } from '../../services/maintenance/control/src/github.ts';
import { jobRoutes } from '../../services/maintenance/control/src/jobs.ts';
import { advance, reconcile, MAX_ATTEMPTS } from '../../services/maintenance/control/src/progress.ts';
import { controlTask, requestTask, taskReport } from '../../services/maintenance/control/src/tasks.ts';
import { controlServer } from '../../services/maintenance/control/src/mcp.ts';
import { protocolHandler } from '../../packages/shared/src/platform.ts';
import type { JobInput } from '../../services/maintenance/control/src/contracts.ts';

const owner = 'owner@example.invalid';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const recipe = {
  recipe_version: 'preparation-recipe/1', id: 'synthetic', revision: 'synthetic-r1', manifest_revision: 'manifest-1',
  adapter: { name: 'synthetic-text', method_version: '1' }, input_format: 'synthetic/plain', parameters: {},
  native_extent: { units: ['u1', 'u2'] }, capabilities: ['source_text'], dependencies: [],
  units: [
    { unit_id: 'acquire', kind: 'acquire', native_extent: {}, depends_on: [] },
    { unit_id: 'prepare-u1', kind: 'prepare', native_extent: { units: ['u1'] }, depends_on: ['acquire'] },
    { unit_id: 'prepare-u2', kind: 'prepare', native_extent: { units: ['u2'] }, depends_on: ['acquire'] },
    { unit_id: 'quality', kind: 'quality', native_extent: { units: ['u1', 'u2'] }, depends_on: ['prepare-u1', 'prepare-u2'],
      required_capabilities: ['source_text'] },
  ],
};

async function setup(recipes: Record<string, unknown> = { 'collection/recipes/synthetic.json': recipe }) {
  const db = localD1();
  const gh = fakeGitHub({ recipes });
  const github = new GitHubActions({ repository: 'owner/app', token: 'synthetic-token' }, gh.fetcher);
  const created = await requestTask(db, owner, { request_key: 'p1', instruction: 'Prepare the synthetic source', kind: 'prepare',
    inputs: [{ kind: 'acquisition', id: 'route-1' }], extent: { units: ['u1', 'u2'] }, capabilities: ['source_text'],
    constraints: { recipe: 'synthetic' }, decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] });
  assert.ok(created.status === 'created');
  const routes = jobRoutes(db, github);
  const post = async (path: string, body: unknown) => {
    const response = await routes(new Request(`https://control.example.invalid${path}`, { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { db, gh, github, task: created.task, post };
}

/** What the runner holds: the exact job text from the dispatch input. */
function dispatched(gh: ReturnType<typeof fakeGitHub>, unit: string) {
  const runs = [...gh.runs.values()].filter(run => (JSON.parse(run.job) as JobInput).unit_id === unit);
  const run = runs[runs.length - 1];
  return { run, job: JSON.parse(run.job) as JobInput, text: run.job };
}

function resultFor(job: JobInput, runId: string, overrides: Record<string, unknown> = {}) {
  return { contract_version: 'maintenance-job/1', task_id: job.task_id, task_revision: job.task_revision, unit_id: job.unit_id,
    attempt: job.attempt, basis_digest: job.basis_digest, run_id: runId, completed_extent: job.native_extent, remaining_extent: {},
    output_refs: [{ artifact_id: `artifact-${job.unit_id}`, sha256: sha(job.unit_id), byte_count: 10 }], coverage_refs: [],
    checkpoint_ref: null, quality_receipt_ref: null, state: 'succeeded', diagnostics: [], ...overrides };
}

async function finish(context: Awaited<ReturnType<typeof setup>>, unit: string, overrides: Record<string, unknown> = {}) {
  const { run, job, text } = dispatched(context.gh, unit);
  const state = await context.post('/internal/jobs/state', { task_id: job.task_id, unit_id: unit, attempt: job.attempt,
    run_id: String(run.id), job_input_basis: sha(text) });
  assert.equal(state.status, 200, unit);
  const reply = await context.post('/internal/jobs/result', { result: resultFor(job, String(run.id), overrides), commit: context.gh.commit });
  run.status = 'completed';
  return { job, run, reply: reply.body };
}

function savePrepared(db: ReturnType<typeof localD1>, unit: string, outputId: string) {
  // Minimal prepared rows so Control can name the quality candidate (foreign keys off for brevity).
  db.sqlite.exec('PRAGMA foreign_keys = OFF');
  db.sqlite.prepare(`INSERT INTO prepared_outputs VALUES (?, 'evidence', '["rev-1"]', 'm1', '{}', '{}', '{}')`).run(outputId);
  db.sqlite.prepare(`INSERT INTO artifacts VALUES (?, 'rev-1', ?, ?, 10, 'text/utf-8', ?)`)
    .run(`artifact-${unit}`, outputId, sha(unit), `prepared/${sha(unit)}/native-body.txt`);
  db.sqlite.exec('PRAGMA foreign_keys = ON');
}

test('units progress through results alone, in dependency order, with exact dependency outputs', async () => {
  const context = await setup();
  const { db, gh, task } = context;
  const first = await advance(db, context.github, task.id);
  assert.deepEqual(first.dispatched, ['acquire']);
  assert.equal((await taskReport(db, owner, task.id))?.state, 'running');
  assert.equal(gh.runs.size, 1);
  // The dispatched text is exactly what Control hashed and the runner will hash.
  const sent = dispatched(gh, 'acquire');
  assert.equal(db.sqlite.prepare('SELECT input_basis FROM maintenance_jobs WHERE unit_id = ?').get('acquire')?.input_basis, sha(sent.text));

  const acquired = await finish(context, 'acquire');
  assert.equal(acquired.reply.status, 'accepted');
  // No chat: the accepted result dispatched both prepare units, each with the acquire output.
  for (const unit of ['prepare-u1', 'prepare-u2']) {
    const { job } = dispatched(gh, unit);
    assert.deepEqual(job.dependency_refs, [{ artifact_id: 'artifact-acquire', sha256: sha('acquire'), byte_count: 10 }]);
    assert.equal(job.recipe_revision, 'synthetic-r1');
    assert.equal(job.manifest_revision, 'manifest-1');
  }
  savePrepared(db, 'prepare-u1', 'output-u1');
  savePrepared(db, 'prepare-u2', 'output-u2');
  await finish(context, 'prepare-u1');
  assert.equal(gh.runs.size, 3, 'quality waits for both prepare units');
  await finish(context, 'prepare-u2');
  const quality = dispatched(gh, 'quality').job;
  assert.deepEqual(quality.constraints.candidate, { added: ['output-u1', 'output-u2'], reused: [], omitted: [] });
  assert.deepEqual(quality.required_capabilities, ['source_text']);
  assert.equal(quality.dependency_refs.length, 2);
  await finish(context, 'quality');
  const report = (await taskReport(db, owner, task.id))!;
  assert.deepEqual(report.remaining_extent, {});
  assert.ok(report.limitations.some(text => text.includes('scope check and selection follow')));
  assert.equal(report.data_current, false, 'MC-02 never selects data');
  assert.equal(db.sqlite.prepare('SELECT current_release_id FROM release_selection').get()?.current_release_id, null);
});

test('state route: exact bytes and own run only; lost dispatch response is confirmed by the run itself', async () => {
  const context = await setup();
  const { db, gh, task, post } = context;
  gh.state.loseNextDispatchResponse = true;
  const first = await advance(db, context.github, task.id);
  assert.deepEqual(first.dispatched, []);
  const job = db.sqlite.prepare('SELECT * FROM maintenance_jobs').get() as Record<string, unknown>;
  assert.deepEqual([job.state, job.run_id], ['intended', null]);
  const { run, text } = dispatched(gh, 'acquire');
  const ask = (changes: Record<string, unknown> = {}) => post('/internal/jobs/state',
    { task_id: task.id, unit_id: 'acquire', attempt: 1, run_id: String(run.id), job_input_basis: sha(text), ...changes });
  assert.equal((await ask({ job_input_basis: 'b'.repeat(64) })).status, 404, 'different job bytes');
  assert.equal((await ask({ run_id: '424242' })).status, 404, 'not a GitHub run of prepare.yml');
  assert.equal((await ask({ extra: 1 })).status, 400);
  const confirmed = await ask();
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.job_state, 'dispatched');
  assert.equal(confirmed.body.run_id, String(run.id));
  assert.equal(confirmed.body.task_state, 'running');
  // Once bound, another run cannot claim this job.
  const other = (await context.github.dispatch(JSON.parse(text))).run_id;
  assert.equal((await ask({ run_id: other })).status, 404);
  // A second advance does not dispatch the same unit again.
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, []);
});

test('result route verifies the run commit through GitHub and is idempotent', async () => {
  const context = await setup();
  const { db, gh, task, post } = context;
  await advance(db, context.github, task.id);
  const { run, job } = dispatched(gh, 'acquire');
  const wrong = await post('/internal/jobs/result', { result: resultFor(job, String(run.id)), commit: 'b'.repeat(40) });
  assert.equal(wrong.body.status, 'rejected');
  const forged = await post('/internal/jobs/result', { result: resultFor(job, '999999'), commit: gh.commit });
  assert.deepEqual(forged.body, { status: 'rejected', reason: 'run is not verifiable' });
  const accepted = await post('/internal/jobs/result', { result: resultFor(job, String(run.id)), commit: gh.commit });
  assert.equal(accepted.body.status, 'accepted');
  const runsAfter = gh.runs.size;
  const repeat = await post('/internal/jobs/result', { result: resultFor(job, String(run.id)), commit: gh.commit });
  assert.equal(repeat.body.status, 'duplicate');
  assert.equal(gh.runs.size, runsAfter, 'a duplicate receipt dispatches nothing new');
  assert.equal((await post('/internal/jobs/result', { result: {}, commit: gh.commit })).body.status, 'rejected');
  assert.equal((await post('/internal/jobs/nothing', {})).status, 404);
});

test('failed units retry up to the limit, then the task is blocked with the reason', async () => {
  const context = await setup();
  const { db, gh, task } = context;
  await advance(db, context.github, task.id);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { job } = await finish(context, 'acquire', { state: 'failed', output_refs: [], completed_extent: {},
      remaining_extent: {}, diagnostics: [{ code: 'no_registered_recipe', message: 'x' }] });
    assert.equal(job.attempt, attempt);
  }
  const report = (await taskReport(db, owner, task.id))!;
  assert.equal(report.state, 'blocked');
  assert.ok(report.limitations.some(text => text.includes(`${MAX_ATTEMPTS} attempts (no_registered_recipe)`)));
  assert.equal(gh.runs.size, MAX_ATTEMPTS);
});

test('reconcile: lost dispatch with no claimable run is retried; a run that ended silently is retried', async () => {
  const context = await setup();
  const { db, gh, task } = context;
  gh.state.loseNextDispatchResponse = true;
  await advance(db, context.github, task.id);
  const lost = dispatched(gh, 'acquire').run;
  // The run is still queued and unclaimed: it may still confirm itself, so nothing changes.
  assert.deepEqual(await reconcile(db, context.github, task.id), []);
  lost.status = 'completed'; lost.conclusion = 'failure';
  assert.equal((await reconcile(db, context.github, task.id)).length, 1);
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, ['acquire']);
  const second = dispatched(gh, 'acquire');
  assert.equal(second.job.attempt, 2);
  // The second run ends without delivering a result.
  second.run.status = 'completed';
  assert.deepEqual(await reconcile(db, context.github, task.id), ['unit acquire attempt 2: run ended without a result']);
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, ['acquire']);
  assert.equal(dispatched(gh, 'acquire').job.attempt, 3);
});

test('pause stops new units, late results cannot advance a cancelled task, resume continues', async () => {
  const context = await setup();
  const { db, gh, task, post } = context;
  await advance(db, context.github, task.id);
  let report = (await taskReport(db, owner, task.id))!;
  assert.equal((await controlTask(db, owner, task.id, report.revision, 'pause')).status, 'ok');
  // The running unit reports while paused: recorded, but nothing new is dispatched.
  const { run, job } = dispatched(gh, 'acquire');
  const reply = await post('/internal/jobs/result', { result: resultFor(job, String(run.id)), commit: gh.commit });
  assert.equal(reply.body.status, 'accepted');
  assert.equal(gh.runs.size, 1);
  report = (await taskReport(db, owner, task.id))!;
  assert.equal((await controlTask(db, owner, task.id, report.revision, 'resume')).status, 'ok');
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, ['prepare-u1', 'prepare-u2']);
  report = (await taskReport(db, owner, task.id))!;
  assert.equal((await controlTask(db, owner, task.id, report.revision, 'cancel')).status, 'ok');
  const late = dispatched(gh, 'prepare-u1');
  const lateReply = await post('/internal/jobs/result', { result: resultFor(late.job, String(late.run.id)), commit: gh.commit });
  assert.equal(lateReply.body.eligible, false);
  assert.equal((await advance(db, context.github, task.id)).dispatched.length, 0);
  assert.equal(gh.runs.size, 3);
});

test('recipe problems block the task with a plain reason; no recipe means no dispatch', async () => {
  for (const [recipes, reason] of [
    [{}, 'not on main'],
    [{ 'collection/recipes/synthetic.json': { ...recipe, units: undefined } }, 'no units'],
    [{ 'collection/recipes/synthetic.json': { ...recipe, units: [{ ...recipe.units[1] }] } }, 'depends on a later unit'],
    [{ 'collection/recipes/synthetic.json': { ...recipe, script: 'run' } }, 'invalid'],
  ] as const) {
    const context = await setup(recipes as Record<string, unknown>);
    const progress = await advance(context.db, context.github, context.task.id);
    assert.equal(progress.state, 'blocked');
    assert.ok(progress.limitation?.includes(reason), `${progress.limitation} / ${reason}`);
    assert.equal(context.gh.runs.size, 0);
  }
  const context = await setup();
  assert.equal((await advance(context.db, null, context.task.id)).limitation, 'dispatch_not_configured');
  // The recipe pinned at first dispatch must not change under a running task.
  await advance(context.db, context.github, context.task.id);
  context.gh.recipes.set('collection/recipes/synthetic.json', { ...recipe, revision: 'synthetic-r2' });
  const changed = await advance(context.db, context.github, context.task.id);
  assert.equal(changed.state, 'blocked');
  assert.ok(changed.limitation?.includes('start a new task'));
});

test('MCP: request_task dispatches, get_task reconciles, cancel asks GitHub to stop runs', async () => {
  const db = localD1();
  const gh = fakeGitHub({ recipes: { 'collection/recipes/synthetic.json': recipe } });
  const github = new GitHubActions({ repository: 'owner/app', token: 't' }, gh.fetcher);
  const handler = protocolHandler(() => controlServer(db, owner, false, github), false);
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(new Request('https://control.example.invalid/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }));
    const text = await response.text();
    const data = text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))!.slice(6);
    return JSON.parse(data);
  };
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const created = await call('tools/call', { name: 'request_task', arguments: { request_key: 'p1', instruction: 'Prepare it',
    kind: 'prepare', inputs: [{ kind: 'acquisition', id: 'route-1' }], extent: { units: ['u1', 'u2'] }, capabilities: ['source_text'],
    constraints: { recipe: 'synthetic' }, decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] } });
  assert.match(created.result.content[0].text, /dispatched acquire/);
  const taskId = JSON.parse(created.result.content[0].text.split('\n\n')[1]).task_id;
  const report = await call('tools/call', { name: 'get_task', arguments: { task_id: taskId } });
  const revision = JSON.parse(report.result.content[0].text.split('\n\n')[1]).revision;
  const cancelled = await call('tools/call', { name: 'control_task', arguments: { task_id: taskId, expected_revision: revision, action: 'cancel' } });
  const body = JSON.parse(cancelled.result.content[0].text.split('\n\n')[1]);
  assert.equal(body.state, 'cancelled');
  assert.deepEqual(body.runs_cancelled, [String([...gh.runs.keys()][0])]);
  assert.equal([...gh.runs.values()][0].conclusion, 'cancelled');
});

test('R22-1: a GitHub outage postpones progression but never breaks or blocks the task tools', async () => {
  for (const mode of ['down', 'offline'] as const) {
    const db = localD1();
    const gh = fakeGitHub({ recipes: { 'collection/recipes/synthetic.json': recipe } });
    const github = new GitHubActions({ repository: 'owner/app', token: 't' }, gh.fetcher);
    const call = mcpCaller(db, github);
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    gh.state[mode] = true;
    const created = await call('tools/call', { name: 'request_task', arguments: requestArguments });
    assert.equal(created.result.isError, undefined, mode);
    assert.match(created.result.content[0].text, /dispatch postponed/);
    const body = JSON.parse(created.result.content[0].text.split('\n\n')[1]);
    assert.equal(body.state, 'queued');
    const report = await call('tools/call', { name: 'get_task', arguments: { task_id: body.task_id } });
    assert.equal(report.result.isError, undefined);
    const saved = JSON.parse(report.result.content[0].text.split('\n\n')[1]);
    assert.equal(saved.state, 'queued', 'a temporary outage never blocks');
    assert.ok(saved.reconciliation.some((note: string) => note.includes('GitHub was unavailable')));
    // Once GitHub answers again, the next check continues the work.
    gh.state[mode] = false;
    await call('tools/call', { name: 'get_task', arguments: { task_id: body.task_id } });
    assert.equal(gh.runs.size, 1);
    assert.equal((await taskReport(db, owner, body.task_id))?.state, 'running');
  }
  // Reconcile alone: an outage while looking for unclaimed runs changes nothing.
  const context = await setup();
  context.gh.state.loseNextDispatchResponse = true;
  await advance(context.db, context.github, context.task.id);
  context.gh.state.down = true;
  assert.deepEqual(await reconcile(context.db, context.github, context.task.id),
    ['GitHub was unavailable; unconfirmed dispatches are checked again later']);
  assert.equal(context.db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()?.state, 'intended');
});

test('R22-2: failed cancellations are reported and retried; an orphaned run is cancelled', async () => {
  const db = localD1();
  const gh = fakeGitHub({ recipes: { 'collection/recipes/synthetic.json': recipe } });
  const github = new GitHubActions({ repository: 'owner/app', token: 't' }, gh.fetcher);
  const call = mcpCaller(db, github);
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const created = JSON.parse((await call('tools/call', { name: 'request_task', arguments: requestArguments })).result.content[0].text.split('\n\n')[1]);
  const run = [...gh.runs.values()][0];
  gh.state.failCancel = true;
  const report = await taskReport(db, owner, created.task_id);
  const cancelled = await call('tools/call', { name: 'control_task', arguments: { task_id: created.task_id, expected_revision: report!.revision, action: 'cancel' } });
  assert.match(cancelled.result.content[0].text, /did not go through; get_task requests it again/);
  const body = JSON.parse(cancelled.result.content[0].text.split('\n\n')[1]);
  assert.deepEqual([body.runs_cancelled, body.cancel_failed], [[], [String(run.id)]]);
  assert.equal(run.status, 'queued');
  // The next check asks again; when GitHub reports the run finished, the job is closed as cancelled.
  gh.state.failCancel = false;
  const again = JSON.parse((await call('tools/call', { name: 'get_task', arguments: { task_id: created.task_id } })).result.content[0].text.split('\n\n')[1]);
  assert.ok(again.reconciliation.some((note: string) => note.includes('cancellation requested again')));
  assert.equal(run.conclusion, 'cancelled');
  await call('tools/call', { name: 'get_task', arguments: { task_id: created.task_id } });
  assert.equal(db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()?.state, 'cancelled');

  // Orphan: the task is cancelled while GitHub is starting the run.
  const context = await setup();
  context.gh.state.onDispatch = () => {
    context.db.sqlite.prepare(`UPDATE maintenance_tasks SET state = 'cancelled', revision = revision + 1 WHERE id = ?`).run(context.task.id);
    context.gh.state.onDispatch = undefined;
  };
  assert.deepEqual((await advance(context.db, context.github, context.task.id)).dispatched, []);
  const orphan = [...context.gh.runs.values()][0];
  assert.equal(orphan.conclusion, 'cancelled', 'the orphaned run was cancelled');
  assert.ok(context.gh.requests.some(request => request.url.endsWith(`/actions/runs/${orphan.id}/cancel`)));
});

const requestArguments = { request_key: 'p1', instruction: 'Prepare it', kind: 'prepare', inputs: [{ kind: 'acquisition', id: 'route-1' }],
  extent: { units: ['u1', 'u2'] }, capabilities: ['source_text'], constraints: { recipe: 'synthetic' },
  decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] };

function mcpCaller(db: ReturnType<typeof localD1>, github: GitHubActions) {
  const handler = protocolHandler(() => controlServer(db, owner, false, github), false);
  let id = 0;
  return async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(new Request('https://control.example.invalid/mcp', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) }));
    const text = await response.text();
    return JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: '))!.slice(6));
  };
}
