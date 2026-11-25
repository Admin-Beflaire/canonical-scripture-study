import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {localD1} from './d1.ts';
import {fakeGitHub} from './github.ts';
import {GitHubActions} from '../../services/maintenance/control/src/github.ts';
import {jobRoutes} from '../../services/maintenance/control/src/jobs.ts';
import {
  advance,
  reconcile,
  MAX_ATTEMPTS,
} from '../../services/maintenance/control/src/progress.ts';
import {
  controlTask,
  requestTask,
  taskReport,
  type TaskRequest,
} from '../../services/maintenance/control/src/tasks.ts';
import {
  controlServer,
  describeProgressFailure,
} from '../../services/maintenance/control/src/mcp.ts';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import type {JobInput} from '../../services/maintenance/control/src/contracts.ts';

const owner = 'owner@example.invalid';
const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const recipe = {
  recipe_version: 'preparation-recipe/1',
  id: 'synthetic',
  revision: 'synthetic-r1',
  manifest_revision: 'manifest-1',
  adapter: {name: 'synthetic-text', method_version: '1'},
  input_format: 'synthetic/plain',
  parameters: {},
  native_extent: {units: ['u1', 'u2']},
  capabilities: ['source_text'],
  dependencies: [],
  units: [
    {
      unit_id: 'prepare-u1',
      kind: 'prepare',
      native_extent: {unit_ids: ['u1']},
      depends_on: [],
    },
    {
      unit_id: 'prepare-u2',
      kind: 'prepare',
      native_extent: {unit_ids: ['u2']},
      depends_on: ['prepare-u1'],
    },
    {
      unit_id: 'quality',
      kind: 'quality',
      native_extent: {unit_ids: ['u1', 'u2']},
      depends_on: ['prepare-u1', 'prepare-u2'],
      required_capabilities: ['source_text'],
    },
  ],
};

const requestArguments: TaskRequest = {
  request_key: 'p1',
  instruction: 'Prepare it',
  steps: ['build'],
  inputs: [{kind: 'acquisition', id: 'route-1'}],
  extent: {units: ['u1', 'u2']},
  capabilities: ['source_text'],
  constraints: {recipe: 'synthetic'},
  decision_refs: [
    {kind: 'admission', ref: 'owner-decision:1', subject: 'route-1'},
  ],
};

async function setup(
  recipes: Record<string, unknown> = {
    'collection/recipes/synthetic.json': recipe,
  },
) {
  const db = localD1();
  const gh = fakeGitHub({recipes});
  const github = new GitHubActions(
    {repository: 'owner/app', token: 'synthetic-token'},
    gh.fetcher,
  );
  const created = await requestTask(db, owner, {
    ...requestArguments,
    instruction: 'Prepare the synthetic source',
  });
  assert.ok(created.status === 'created');
  const routes = jobRoutes(db, github);
  const post = async (path: string, body: unknown) => {
    const response = await routes(
      new Request(`https://control.example.invalid${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return {db, gh, github, task: created.task, post};
}

/** What the runner holds: the exact job text from the dispatch input. */
function dispatched(gh: ReturnType<typeof fakeGitHub>, unit: string) {
  const runs = [...gh.runs.values()].filter(
    run => (JSON.parse(run.job) as JobInput).unit_id === unit,
  );
  const run = runs[runs.length - 1];
  return {run, job: JSON.parse(run.job) as JobInput, text: run.job};
}

function resultFor(
  job: JobInput,
  runId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    contract_version: 'maintenance-job/1',
    task_id: job.task_id,
    task_revision: job.task_revision,
    unit_id: job.unit_id,
    attempt: job.attempt,
    basis_digest: job.basis_digest,
    run_id: runId,
    completed_extent: job.native_extent,
    remaining_extent: {},
    output_refs: [
      {
        artifact_id: `artifact-${job.unit_id}`,
        sha256: sha(job.unit_id),
        byte_count: 10,
      },
    ],
    coverage_refs: [],
    quality_receipt_ref: null,
    state: 'succeeded',
    diagnostics: [],
    ...overrides,
  };
}

async function finish(
  context: Awaited<ReturnType<typeof setup>>,
  unit: string,
  overrides: Record<string, unknown> = {},
) {
  const {run, job, text} = dispatched(context.gh, unit);
  const state = await context.post('/internal/jobs/state', {
    task_id: job.task_id,
    unit_id: unit,
    attempt: job.attempt,
    run_id: String(run.id),
    job_input_basis: sha(text),
  });
  assert.equal(state.status, 200, unit);
  const reply = await context.post('/internal/jobs/result', {
    result: resultFor(job, String(run.id), overrides),
    commit: context.gh.commit,
  });
  run.status = 'completed';
  return {job, run, reply: reply.body};
}

function savePrepared(
  db: ReturnType<typeof localD1>,
  unit: string,
  outputId: string,
) {
  // Minimal prepared rows so Control can name the quality candidate (foreign keys off for brevity).
  db.sqlite.exec('PRAGMA foreign_keys = OFF');
  db.sqlite
    .prepare(
      `INSERT INTO prepared_outputs VALUES (?, 'evidence', '["rev-1"]', 'm1', '{}', '{}', '{}')`,
    )
    .run(outputId);
  db.sqlite
    .prepare(
      `INSERT INTO artifacts VALUES (?, 'rev-1', ?, ?, 10, 'text/utf-8', ?)`,
    )
    .run(
      `artifact-${unit}`,
      outputId,
      sha(unit),
      `prepared/${sha(unit)}/native-body.txt`,
    );
  db.sqlite.exec('PRAGMA foreign_keys = ON');
}

test('units progress through results alone, in dependency order, with exact dependency outputs', async () => {
  const context = await setup();
  const {db, gh, task} = context;
  const first = await advance(db, context.github, task.id);
  assert.deepEqual(first.dispatched, ['prepare-u1']);
  assert.equal((await taskReport(db, owner, task.id))?.state, 'running');
  assert.equal(gh.runs.size, 1);
  // The dispatched text is exactly what Control hashed and the runner will hash.
  const sent = dispatched(gh, 'prepare-u1');
  assert.equal(
    db.sqlite
      .prepare('SELECT input_basis FROM maintenance_jobs WHERE unit_id = ?')
      .get('prepare-u1')?.input_basis,
    sha(sent.text),
  );

  assert.deepEqual(dispatched(gh, 'prepare-u1').job.dependency_refs, []);
  const first_done = await finish(context, 'prepare-u1');
  assert.equal(first_done.reply.status, 'accepted');
  // No chat: the accepted result dispatched the next unit, with the first unit's output.
  const {job} = dispatched(gh, 'prepare-u2');
  assert.deepEqual(job.dependency_refs, [
    {
      artifact_id: 'artifact-prepare-u1',
      sha256: sha('prepare-u1'),
      byte_count: 10,
    },
  ]);
  assert.equal(job.recipe_revision, 'synthetic-r1');
  assert.equal(job.manifest_revision, 'manifest-1');
  savePrepared(db, 'prepare-u1', 'output-u1');
  savePrepared(db, 'prepare-u2', 'output-u2');
  assert.equal(gh.runs.size, 2, 'quality waits for both prepare units');
  await finish(context, 'prepare-u2');
  const quality = dispatched(gh, 'quality').job;
  assert.deepEqual(quality.constraints.candidate, {
    added: ['output-u1', 'output-u2'],
    reused: [],
    omitted: [],
  });
  assert.deepEqual(quality.required_capabilities, ['source_text']);
  assert.equal(quality.dependency_refs.length, 2);
  await finish(context, 'quality');
  const report = (await taskReport(db, owner, task.id))!;
  assert.deepEqual(report.remaining_extent, {});
  // Control's own scope check runs next; these minimal rows have no receipt or coverage, so
  // it fails and the current release stays unchanged (promotion is tested in selection.test.ts).
  assert.equal(report.state, 'blocked');
  assert.equal(report.checks.scope, 'failed');
  assert.ok(report.limitations.includes('no quality receipt'));
  assert.equal(report.data_current, false);
  assert.equal(
    db.sqlite.prepare('SELECT current_release_id FROM release_selection').get()
      ?.current_release_id,
    null,
  );
});

test('state route: exact bytes and own run only; lost dispatch response is confirmed by the run itself', async () => {
  const context = await setup();
  const {db, gh, task, post} = context;
  gh.state.loseNextDispatchResponse = true;
  const first = await advance(db, context.github, task.id);
  assert.deepEqual(first.dispatched, []);
  const job = db.sqlite
    .prepare('SELECT * FROM maintenance_jobs')
    .get() as Record<string, unknown>;
  assert.deepEqual([job.state, job.run_id], ['intended', null]);
  const {run, text} = dispatched(gh, 'prepare-u1');
  const ask = (changes: Record<string, unknown> = {}) =>
    post('/internal/jobs/state', {
      task_id: task.id,
      unit_id: 'prepare-u1',
      attempt: 1,
      run_id: String(run.id),
      job_input_basis: sha(text),
      ...changes,
    });
  assert.equal(
    (await ask({job_input_basis: 'b'.repeat(64)})).status,
    404,
    'different job bytes',
  );
  assert.equal(
    (await ask({run_id: '424242'})).status,
    404,
    'not a GitHub run of prepare.yml',
  );
  assert.equal((await ask({extra: 1})).status, 400);
  const confirmed = await ask();
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.job_state, 'dispatched');
  assert.equal(confirmed.body.run_id, String(run.id));
  assert.equal(confirmed.body.task_state, 'running');
  // Once bound, another run cannot claim this job.
  const other = (await context.github.dispatch(JSON.parse(text))).run_id;
  assert.equal((await ask({run_id: other})).status, 404);
  // A second advance does not dispatch the same unit again.
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, []);
});

test('result route verifies the run commit through GitHub and is idempotent', async () => {
  const context = await setup();
  const {db, gh, task, post} = context;
  await advance(db, context.github, task.id);
  const {run, job} = dispatched(gh, 'prepare-u1');
  const wrong = await post('/internal/jobs/result', {
    result: resultFor(job, String(run.id)),
    commit: 'b'.repeat(40),
  });
  assert.equal(wrong.body.status, 'rejected');
  const logged = mock.method(console, 'error', () => {});
  let forged;
  try {
    forged = await post('/internal/jobs/result', {
      result: resultFor(job, '999999'),
      commit: gh.commit,
    });
    // The run lookup failure is no longer swallowed: it is logged as one safe record.
    const lines = logged.mock.calls.map(call =>
      JSON.parse(String(call.arguments[0])),
    );
    assert.deepEqual(
      lines.map(line => [line.stage, line.code, line.ids.run]),
      [['run_lookup', 'run_not_verifiable', '999999']],
    );
  } finally {
    logged.mock.restore();
  }
  assert.deepEqual(forged.body, {
    status: 'rejected',
    reason: 'run is not verifiable',
  });
  const accepted = await post('/internal/jobs/result', {
    result: resultFor(job, String(run.id)),
    commit: gh.commit,
  });
  assert.equal(accepted.body.status, 'accepted');
  const runsAfter = gh.runs.size;
  const repeat = await post('/internal/jobs/result', {
    result: resultFor(job, String(run.id)),
    commit: gh.commit,
  });
  assert.equal(repeat.body.status, 'duplicate');
  assert.equal(
    gh.runs.size,
    runsAfter,
    'a duplicate receipt dispatches nothing new',
  );
  assert.equal(
    (await post('/internal/jobs/result', {result: {}, commit: gh.commit})).body
      .status,
    'rejected',
  );
  assert.equal((await post('/internal/jobs/nothing', {})).status, 404);
});

test('failed units retry up to the limit, then the task is blocked with the reason', async () => {
  const context = await setup();
  const {db, gh, task} = context;
  await advance(db, context.github, task.id);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const {job} = await finish(context, 'prepare-u1', {
      state: 'failed',
      output_refs: [],
      completed_extent: {},
      remaining_extent: {},
      diagnostics: [{code: 'no_registered_recipe', message: 'x'}],
    });
    assert.equal(job.attempt, attempt);
  }
  const report = (await taskReport(db, owner, task.id))!;
  assert.equal(report.state, 'blocked');
  assert.ok(
    report.limitations.some(text =>
      text.includes(`${MAX_ATTEMPTS} attempts (no_registered_recipe)`),
    ),
  );
  assert.equal(gh.runs.size, MAX_ATTEMPTS);
});

test('reconcile: lost dispatch with no claimable run is retried; a run that ended silently is retried', async () => {
  const context = await setup();
  const {db, gh, task} = context;
  gh.state.loseNextDispatchResponse = true;
  await advance(db, context.github, task.id);
  const lost = dispatched(gh, 'prepare-u1').run;
  // The run is still queued and unclaimed: it may still confirm itself, so nothing changes.
  assert.deepEqual(await reconcile(db, context.github, task.id), []);
  lost.status = 'completed';
  lost.conclusion = 'failure';
  assert.equal((await reconcile(db, context.github, task.id)).length, 1);
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, [
    'prepare-u1',
  ]);
  const second = dispatched(gh, 'prepare-u1');
  assert.equal(second.job.attempt, 2);
  // The second run ends without delivering a result.
  second.run.status = 'completed';
  assert.deepEqual(await reconcile(db, context.github, task.id), [
    'unit prepare-u1 attempt 2: run ended without a result',
  ]);
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, [
    'prepare-u1',
  ]);
  assert.equal(dispatched(gh, 'prepare-u1').job.attempt, 3);
});

test('pause stops new units, late results cannot advance a cancelled task, resume continues', async () => {
  const context = await setup();
  const {db, gh, task, post} = context;
  await advance(db, context.github, task.id);
  let report = (await taskReport(db, owner, task.id))!;
  assert.equal(
    (await controlTask(db, owner, task.id, report.revision, 'pause')).status,
    'ok',
  );
  // The running unit reports while paused: recorded, but nothing new is dispatched.
  const {run, job} = dispatched(gh, 'prepare-u1');
  const reply = await post('/internal/jobs/result', {
    result: resultFor(job, String(run.id)),
    commit: gh.commit,
  });
  assert.equal(reply.body.status, 'accepted');
  assert.equal(gh.runs.size, 1);
  report = (await taskReport(db, owner, task.id))!;
  assert.equal(
    (await controlTask(db, owner, task.id, report.revision, 'resume')).status,
    'ok',
  );
  assert.deepEqual((await advance(db, context.github, task.id)).dispatched, [
    'prepare-u2',
  ]);
  report = (await taskReport(db, owner, task.id))!;
  assert.equal(
    (await controlTask(db, owner, task.id, report.revision, 'cancel')).status,
    'ok',
  );
  const late = dispatched(gh, 'prepare-u1');
  const lateReply = await post('/internal/jobs/result', {
    result: resultFor(late.job, String(late.run.id)),
    commit: gh.commit,
  });
  assert.equal(lateReply.body.eligible, false);
  assert.equal(
    (await advance(db, context.github, task.id)).dispatched.length,
    0,
  );
  assert.equal(gh.runs.size, 2);
});

test('recipe problems block the task with a plain reason; no recipe means no dispatch', async () => {
  for (const [recipes, reason] of [
    [{}, 'not on main'],
    [
      {'collection/recipes/synthetic.json': {...recipe, units: undefined}},
      'no units',
    ],
    [
      {
        'collection/recipes/synthetic.json': {
          ...recipe,
          units: [{...recipe.units[1]}],
        },
      },
      'depends on a later unit',
    ],
    [
      {'collection/recipes/synthetic.json': {...recipe, script: 'run'}},
      'invalid',
    ],
  ] as const) {
    const context = await setup(recipes as Record<string, unknown>);
    const progress = await advance(context.db, context.github, context.task.id);
    assert.equal(progress.state, 'blocked');
    assert.ok(
      progress.limitation?.includes(reason),
      `${progress.limitation} / ${reason}`,
    );
    assert.equal(context.gh.runs.size, 0);
  }
  const context = await setup();
  assert.equal(
    (await advance(context.db, null, context.task.id)).limitation,
    'dispatch_not_configured',
  );
  // The recipe pinned at first dispatch must not change under a running task.
  await advance(context.db, context.github, context.task.id);
  context.gh.recipes.set('collection/recipes/synthetic.json', {
    ...recipe,
    revision: 'synthetic-r2',
  });
  const changed = await advance(context.db, context.github, context.task.id);
  assert.equal(changed.state, 'blocked');
  assert.ok(changed.limitation?.includes('start a new task'));
});

/** A local database and a fake GitHub holding the synthetic recipe. */
function githubWorld() {
  const db = localD1();
  const gh = fakeGitHub({
    recipes: {'collection/recipes/synthetic.json': recipe},
  });
  const github = new GitHubActions(
    {repository: 'owner/app', token: 't'},
    gh.fetcher,
  );
  return {db, gh, github};
}

/** An MCP caller that has already completed the initialize handshake. */
async function initializedCaller(
  db: ReturnType<typeof localD1>,
  github: GitHubActions,
) {
  const call = mcpCaller(db, github);
  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 't', version: '1'},
  });
  return call;
}

test('MCP: request_task dispatches, get_task reconciles, cancel asks GitHub to stop runs', async () => {
  const {db, gh, github} = githubWorld();
  const handler = protocolHandler(
    () => controlServer(db, owner, false, github),
    false,
  );
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(
      new Request('https://control.example.invalid/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
      }),
    );
    const text = await response.text();
    const data = text.startsWith('{')
      ? text
      : text
          .split('\n')
          .find(line => line.startsWith('data: '))!
          .slice(6);
    return JSON.parse(data);
  };
  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {name: 't', version: '1'},
  });
  const created = await call('tools/call', {
    name: 'request_task',
    arguments: {...requestArguments},
  });
  assert.match(created.result.content[0].text, /dispatched prepare-u1/);
  const taskId = JSON.parse(
    created.result.content[0].text.split('\n\n')[1],
  ).task_id;
  const report = await call('tools/call', {
    name: 'get_task',
    arguments: {task_id: taskId},
  });
  const revision = JSON.parse(
    report.result.content[0].text.split('\n\n')[1],
  ).revision;
  const cancelled = await call('tools/call', {
    name: 'control_task',
    arguments: {task_id: taskId, expected_revision: revision, action: 'cancel'},
  });
  const body = JSON.parse(cancelled.result.content[0].text.split('\n\n')[1]);
  assert.equal(body.state, 'cancelled');
  assert.deepEqual(body.runs_cancelled, [String([...gh.runs.keys()][0])]);
  assert.equal([...gh.runs.values()][0].conclusion, 'cancelled');
});

test('R22-1: a GitHub outage postpones progression but never breaks or blocks the task tools', async () => {
  for (const mode of ['down', 'offline'] as const) {
    const {db, gh, github} = githubWorld();
    const call = await initializedCaller(db, github);
    gh.state[mode] = true;
    const created = await call('tools/call', {
      name: 'request_task',
      arguments: {...requestArguments},
    });
    assert.equal(created.result.isError, undefined, mode);
    assert.match(created.result.content[0].text, /dispatch postponed/);
    const body = JSON.parse(created.result.content[0].text.split('\n\n')[1]);
    assert.equal(body.state, 'queued');
    const report = await call('tools/call', {
      name: 'get_task',
      arguments: {task_id: body.task_id},
    });
    assert.equal(report.result.isError, undefined);
    const saved = JSON.parse(report.result.content[0].text.split('\n\n')[1]);
    assert.equal(saved.state, 'queued', 'a temporary outage never blocks');
    assert.ok(
      saved.reconciliation.some((note: string) =>
        note.includes('GitHub was unavailable'),
      ),
    );
    // Once GitHub answers again, the next check continues the work.
    gh.state[mode] = false;
    await call('tools/call', {
      name: 'get_task',
      arguments: {task_id: body.task_id},
    });
    assert.equal(gh.runs.size, 1);
    assert.equal((await taskReport(db, owner, body.task_id))?.state, 'running');
  }
  // Reconcile alone: an outage while looking for unclaimed runs changes nothing.
  const context = await setup();
  context.gh.state.loseNextDispatchResponse = true;
  await advance(context.db, context.github, context.task.id);
  context.gh.state.down = true;
  assert.deepEqual(
    await reconcile(context.db, context.github, context.task.id),
    ['GitHub was unavailable; unconfirmed dispatches are checked again later'],
  );
  assert.equal(
    context.db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()
      ?.state,
    'intended',
  );
});

test('R22-2: failed cancellations are reported and retried', async () => {
  const {db, gh, github} = githubWorld();
  const call = await initializedCaller(db, github);
  const created = JSON.parse(
    (
      await call('tools/call', {
        name: 'request_task',
        arguments: {...requestArguments},
      })
    ).result.content[0].text.split('\n\n')[1],
  );
  const run = [...gh.runs.values()][0];
  gh.state.failCancel = true;
  const report = await taskReport(db, owner, created.task_id);
  const cancelled = await call('tools/call', {
    name: 'control_task',
    arguments: {
      task_id: created.task_id,
      expected_revision: report!.revision,
      action: 'cancel',
    },
  });
  assert.match(
    cancelled.result.content[0].text,
    /did not go through; get_task requests it again/,
  );
  const body = JSON.parse(cancelled.result.content[0].text.split('\n\n')[1]);
  assert.deepEqual(
    [body.runs_cancelled, body.cancel_failed],
    [[], [String(run.id)]],
  );
  assert.equal(run.status, 'queued');
  // The next check asks again; when GitHub reports the run finished, the job is closed as cancelled.
  gh.state.failCancel = false;
  const again = JSON.parse(
    (
      await call('tools/call', {
        name: 'get_task',
        arguments: {task_id: created.task_id},
      })
    ).result.content[0].text.split('\n\n')[1],
  );
  assert.ok(
    again.reconciliation.some((note: string) =>
      note.includes('cancellation requested again'),
    ),
  );
  assert.equal(run.conclusion, 'cancelled');
  await call('tools/call', {
    name: 'get_task',
    arguments: {task_id: created.task_id},
  });
  assert.equal(
    db.sqlite.prepare('SELECT state FROM maintenance_jobs').get()?.state,
    'cancelled',
  );
});

test('R22-2: a run that GitHub starts for a cancelled task is cancelled', async () => {
  // Orphan: the task is cancelled while GitHub is starting the run.
  const context = await setup();
  context.gh.state.onDispatch = () => {
    context.db.sqlite
      .prepare(
        `UPDATE maintenance_tasks SET state = 'cancelled', revision = revision + 1 WHERE id = ?`,
      )
      .run(context.task.id);
    context.gh.state.onDispatch = undefined;
  };
  assert.deepEqual(
    (await advance(context.db, context.github, context.task.id)).dispatched,
    [],
  );
  const orphan = [...context.gh.runs.values()][0];
  assert.equal(
    orphan.conclusion,
    'cancelled',
    'the orphaned run was cancelled',
  );
  assert.ok(
    context.gh.requests.some(request =>
      request.url.endsWith(`/actions/runs/${orphan.id}/cancel`),
    ),
  );
});

function mcpCaller(db: ReturnType<typeof localD1>, github: GitHubActions) {
  const handler = protocolHandler(
    () => controlServer(db, owner, false, github),
    false,
  );
  let id = 0;
  return async (method: string, params: Record<string, unknown> = {}) => {
    const response = await handler.fetch(
      new Request('https://control.example.invalid/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
      }),
    );
    const text = await response.text();
    return JSON.parse(
      text.startsWith('{')
        ? text
        : text
            .split('\n')
            .find(line => line.startsWith('data: '))!
            .slice(6),
    );
  };
}

test('R22-4: a run that confirms itself before GitHub replies is the same dispatch, not an orphan', async () => {
  const context = await setup();
  const {db, gh, task, post} = context;
  context.gh.state.onDispatch = async run => {
    // The runner starts and reads its state while Control still awaits the dispatch reply.
    const confirmed = await post('/internal/jobs/state', {
      task_id: task.id,
      unit_id: 'prepare-u1',
      attempt: 1,
      run_id: String(run.id),
      job_input_basis: sha(run.job),
    });
    assert.equal(confirmed.status, 200);
  };
  const progress = await advance(db, context.github, task.id);
  assert.deepEqual(progress.dispatched, ['prepare-u1']);
  const run = [...gh.runs.values()][0];
  assert.equal(
    run.conclusion,
    null,
    'the legitimately claimed run is not cancelled',
  );
  assert.ok(!gh.requests.some(request => request.url.endsWith('/cancel')));
  const job = db.sqlite
    .prepare('SELECT state, run_id FROM maintenance_jobs')
    .get() as Record<string, unknown>;
  assert.deepEqual([job.state, job.run_id], ['dispatched', String(run.id)]);
  assert.equal((await taskReport(db, owner, task.id))?.state, 'running');
});

test('R22-5: a losing first advance never dispatches under a recipe revision other than the saved pin', async () => {
  const context = await setup();
  const {db, gh, task} = context;
  gh.state.onRecipeRead = () => {
    // A concurrent first advance pins revision r2 while this one still holds r1.
    gh.state.onRecipeRead = undefined;
    const row = db.sqlite
      .prepare('SELECT outcome_json FROM maintenance_tasks WHERE id = ?')
      .get(task.id) as {outcome_json: string};
    const outcome = {
      ...JSON.parse(row.outcome_json),
      recipe_revision: 'synthetic-r2',
    };
    db.sqlite
      .prepare(
        'UPDATE maintenance_tasks SET revision = revision + 1, outcome_json = ? WHERE id = ?',
      )
      .run(JSON.stringify(outcome), task.id);
  };
  const progress = await advance(db, context.github, task.id);
  assert.deepEqual(progress.dispatched, []);
  assert.equal(gh.runs.size, 0, 'nothing dispatched under r1');
  // The next advance sees the saved pin r2 differ from main's r1 and blocks with the reason.
  const next = await advance(db, context.github, task.id);
  assert.equal(next.state, 'blocked');
  assert.ok(
    next.limitation?.includes(
      'recipe changed from synthetic-r2 to synthetic-r1',
    ),
  );
  assert.equal(gh.runs.size, 0);
});

test('a recipe that is not valid UTF-8 blocks the task as a recipe problem, not an outage', async () => {
  const context = await setup();
  context.gh.state.rawRecipes.set(
    'collection/recipes/synthetic.json',
    new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  );
  const progress = await advance(context.db, context.github, context.task.id);
  assert.equal(progress.state, 'blocked');
  assert.match(progress.limitation ?? '', /not valid UTF-8/);
});

test('R22-6: only the run GitHub titled with this job can claim a lost dispatch', async () => {
  const context = await setup();
  const {db, gh, task, post} = context;
  gh.state.loseNextDispatchResponse = true;
  await advance(db, context.github, task.id);
  const intended = dispatched(gh, 'prepare-u1');
  // Another unbound, unfinished prepare.yml run on main (a different job) tries to claim the intent
  // with the right job digest: GitHub's title for that run names a different job, so it is refused.
  const other = await context.github.dispatch({
    ...intended.job,
    unit_id: 'someone-else',
  });
  const claim = (runId: string) =>
    post('/internal/jobs/state', {
      task_id: task.id,
      unit_id: 'prepare-u1',
      attempt: 1,
      run_id: runId,
      job_input_basis: sha(intended.text),
    });
  assert.equal((await claim(other.run_id)).status, 404);
  assert.equal(
    db.sqlite.prepare('SELECT run_id FROM maintenance_jobs').get()?.run_id,
    null,
  );
  // The run that really received the job still confirms itself.
  const confirmed = await claim(String(intended.run.id));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.run_id, String(intended.run.id));
});

test('R22-7: a lost dispatch is never retried on a partial run listing', async () => {
  const context = await setup();
  const {db, gh, task} = context;
  gh.state.loseNextDispatchResponse = true;
  await advance(db, context.github, task.id);
  // 150 newer finished runs push the intended (still queued) run off the newest page.
  for (let i = 0; i < 150; i++) {
    const {run_id} = await context.github.dispatch({
      ...dispatched(gh, 'prepare-u1').job,
      unit_id: `noise-${i}`,
    });
    Object.assign(gh.runs.get(Number(run_id))!, {
      status: 'completed',
      conclusion: 'success',
    });
  }
  assert.deepEqual(await reconcile(db, context.github, task.id), []);
  assert.equal(
    db.sqlite
      .prepare('SELECT state FROM maintenance_jobs WHERE unit_id = ?')
      .get('prepare-u1')?.state,
    'intended',
  );
  // A listing too long to be complete leaves the intent unresolved, with a note.
  for (let i = 0; i < 1001; i++) {
    const {run_id} = await context.github.dispatch({
      ...dispatched(gh, 'prepare-u1').job,
      unit_id: `wait-${i}`,
    });
    Object.assign(gh.runs.get(Number(run_id))!, {status: 'waiting'});
  }
  assert.deepEqual(await reconcile(db, context.github, task.id), [
    'The list of unfinished runs was incomplete; unconfirmed dispatches are checked again later',
  ]);
  assert.equal(
    db.sqlite
      .prepare('SELECT state FROM maintenance_jobs WHERE unit_id = ?')
      .get('prepare-u1')?.state,
    'intended',
  );
});

test('Control progression failures distinguish D1 write quota from other errors without leaking details', () => {
  assert.deepEqual(
    describeProgressFailure(
      'advance',
      new Error(
        "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade or wait.",
      ),
    ),
    {
      operation: 'advance',
      code: 'd1_write_quota',
      message: 'Cloudflare D1 daily row write limit exceeded.',
    },
  );
  assert.deepEqual(
    describeProgressFailure(
      'reconcile',
      new Error('secret-token: unexpected database error'),
    ),
    {
      operation: 'reconcile',
      code: 'failed',
      message: 'Progression failed; inspect Worker logs.',
    },
  );
});

const acquireRecipe = {
  recipe_version: 'preparation-recipe/1',
  id: 'acquire-synthetic',
  revision: 'acquire-synthetic/1',
  manifest_revision: 'route/1',
  adapter: {name: 'acquire-only', method_version: 'acquire-only/1'},
  input_format: 'archive/opaque',
  parameters: {manifest: 'synthetic.json'},
  native_extent: {component: 'revision/1'},
  capabilities: [],
  dependencies: ['route/1'],
  units: [
    {
      unit_id: 'acquire',
      kind: 'acquire',
      native_extent: {component: 'revision/1'},
      depends_on: [],
    },
  ],
};

/** Record the acquired original and its admission, as the executor's receipt would show. */
function recordAcquiredOriginal(db: DatabaseSync) {
  for (const [id, kind, parent] of [
    ['work', 'work', null],
    ['edition', 'edition', 'work'],
    ['representation', 'representation', 'edition'],
    ['revision/1', 'source_revision', 'representation'],
  ]) {
    const details =
      kind === 'source_revision'
        ? JSON.stringify({
            sha256: sha('archive'),
            byte_count: 7,
            locator: `originals/revision/1/${sha('archive')}/original`,
          })
        : '{}';
    db.prepare('INSERT INTO source_nodes VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      kind,
      parent,
      id,
      'synthetic',
      'synthetic',
      details,
    );
  }
  db.prepare('INSERT INTO admissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'admission',
    'revision/1',
    'archive',
    'synthetic',
    '[]',
    '[]',
    '[]',
    1,
    'unresolved',
  );
}

type Context = Awaited<ReturnType<typeof setup>>;

/** Request a task whose fetch step runs the synthetic acquire recipe. */
async function requestAcquire(
  ctx: Context,
  steps: ('fetch' | 'select')[],
  constraints: Record<string, unknown> = {},
) {
  const created = await requestTask(ctx.db, owner, {
    request_key: 'acquire',
    instruction: 'Acquire the synthetic source',
    steps,
    inputs: [
      {kind: 'acquisition', id: 'route/1'},
      {kind: 'source_revision', id: 'revision/1'},
    ],
    extent: {component: 'revision/1'},
    capabilities: [],
    constraints: {fetch_recipe: 'acquire-synthetic', ...constraints},
    decision_refs: [
      {kind: 'admission', ref: 'owner-decision:1', subject: 'route/1'},
      {kind: 'admission', ref: 'owner-decision:1', subject: 'revision/1'},
    ],
  });
  assert.equal(created.status, 'created');
  if (created.status !== 'created') throw new Error('task not created');
  await advance(ctx.db, ctx.github, created.task.id);
  return created.task.id;
}

/** The acquire job runs, the original is recorded, and its result arrives. */
async function finishAcquire(ctx: Context) {
  const {run, job, text} = dispatched(ctx.gh, 'acquire');
  const state = await ctx.post('/internal/jobs/state', {
    task_id: job.task_id,
    unit_id: 'acquire',
    attempt: job.attempt,
    run_id: String(run.id),
    job_input_basis: sha(text),
  });
  assert.equal(state.status, 200);
  recordAcquiredOriginal(ctx.db.sqlite);
  await ctx.post('/internal/jobs/result', {
    result: resultFor(job, String(run.id), {output_refs: []}),
    commit: ctx.gh.commit,
  });
}

const acquireContext = () =>
  setup({'collection/recipes/acquire-synthetic.json': acquireRecipe});

test('an acquire task completes with the original recorded and never touches a release', async () => {
  const ctx = await acquireContext();
  const id = await requestAcquire(ctx, ['fetch']);
  await finishAcquire(ctx);
  const report = (await taskReport(ctx.db, owner, id))!;
  assert.equal(report.state, 'completed');
  assert.equal(report.data_current, false);
  assert.equal(
    ctx.db.sqlite
      .prepare('SELECT current_release_id FROM release_selection')
      .get()?.current_release_id,
    null,
  );
});

test('a fetch followed by a select goes on to the select step instead of completing', async () => {
  const ctx = await acquireContext();
  const id = await requestAcquire(ctx, ['fetch', 'select'], {
    candidate: 'task-that-does-not-exist',
  });
  await finishAcquire(ctx);
  const report = (await taskReport(ctx.db, owner, id))!;
  assert.equal(report.state, 'blocked', 'the select step ran and refused');
  assert.ok(
    report.limitations.some(text => text.includes('was not found')),
    JSON.stringify(report.limitations),
  );
});

test('acquire-only validation stops unsuitable recipes and incomplete references before dispatch', async () => {
  const only = {
    recipe_version: 'preparation-recipe/1',
    id: 'only',
    revision: 'only/1',
    manifest_revision: 'route/1',
    adapter: {name: 'acquire-only', method_version: 'acquire-only/1'},
    input_format: 'archive/opaque',
    parameters: {},
    native_extent: {component: 'rev/1'},
    capabilities: [],
    dependencies: [],
    units: [
      {
        unit_id: 'acquire',
        kind: 'acquire',
        native_extent: {component: 'rev/1'},
        depends_on: [],
      },
    ],
  };
  for (const variant of ['build-kind', 'missing-revision', 'receipt-fields']) {
    const ctx = await setup({'collection/recipes/only.json': only});
    const inputs =
      variant === 'missing-revision'
        ? [{kind: 'acquisition' as const, id: 'route/1'}]
        : [
            {
              kind: 'acquisition' as const,
              id: 'route/1',
              ...(variant === 'receipt-fields' ? {sha256: sha('x')} : {}),
            },
            {kind: 'source_revision' as const, id: 'rev/1'},
          ];
    const created = await requestTask(ctx.db, owner, {
      request_key: variant,
      instruction: 'Acquire',
      steps: variant === 'build-kind' ? ['build'] : ['fetch'],
      inputs,
      extent: {component: 'rev/1'},
      capabilities: variant === 'build-kind' ? ['source_text'] : [],
      constraints:
        variant === 'build-kind' ? {recipe: 'only'} : {fetch_recipe: 'only'},
      decision_refs: inputs.map(ref => ({
        kind: 'admission' as const,
        ref: 'owner:1',
        subject: ref.id,
      })),
    });
    assert.equal(created.status, 'created');
    if (created.status !== 'created') throw new Error('task not created');
    const result = await advance(ctx.db, ctx.github, created.task.id);
    assert.equal(result.state, 'blocked');
    assert.match(
      result.limitation!,
      variant === 'build-kind'
        ? /fetch recipe cannot build/
        : variant === 'missing-revision'
          ? /source_revision/
          : /omit sha256/,
    );
    assert.equal(ctx.gh.runs.size, 0);
  }
});

/** A task that fetches, then builds, from a fetch recipe and a build recipe. */
async function chainedTask() {
  const fetchRecipe = {
    ...recipe,
    id: 'fetch-synthetic',
    revision: 'fetch-synthetic/1',
    native_extent: {component: 'c1'},
    capabilities: [],
    units: [
      {
        unit_id: 'acquire',
        kind: 'acquire',
        native_extent: {component: 'c1'},
        depends_on: [],
      },
    ],
  };
  const context = await setup({
    'collection/recipes/synthetic.json': recipe,
    'collection/recipes/fetch-synthetic.json': fetchRecipe,
  });
  const chained = await requestTask(context.db, owner, {
    request_key: 'c1',
    instruction: 'Fetch and prepare the synthetic source',
    steps: ['fetch', 'build'],
    inputs: [{kind: 'acquisition', id: 'route-1'}],
    extent: {units: ['u1', 'u2']},
    capabilities: ['source_text'],
    constraints: {fetch_recipe: 'fetch-synthetic', recipe: 'synthetic'},
    decision_refs: [
      {kind: 'admission', ref: 'owner-decision:1', subject: 'route-1'},
    ],
  });
  assert.ok(chained.status === 'created');
  return {context, id: chained.task.id};
}

test('one task chains its steps: the fetch runs first, the build never fetches and needs no link to another task', async () => {
  const {context, id} = await chainedTask();
  const {db, gh} = context;
  // The fetch runs first and alone, without the build's capabilities.
  assert.deepEqual((await advance(db, context.github, id)).dispatched, [
    'acquire',
  ]);
  const fetchJob = dispatched(gh, 'acquire').job;
  assert.deepEqual(fetchJob.required_capabilities, []);
  assert.equal(gh.runs.size, 1);
  await finish(context, 'acquire');
  // Once the original is kept, the same task goes on to the build, which has no fetch dependency.
  const {job} = dispatched(gh, 'prepare-u1');
  assert.equal(job.task_id, id);
  assert.deepEqual(job.dependency_refs, []);
  assert.equal((await taskReport(db, owner, id))!.state, 'running');
  assert.equal(
    (await advance(db, context.github, id)).dispatched.length,
    0,
    'nothing runs twice',
  );
});

test('each recipe step keeps its own pin: a changed fetch recipe blocks the task before the build starts', async () => {
  const {context, id} = await chainedTask();
  await advance(context.db, context.github, id);
  const row = context.db.sqlite
    .prepare('SELECT outcome_json FROM maintenance_tasks WHERE id = ?')
    .get(id) as {outcome_json: string};
  const pinned = JSON.parse(row.outcome_json) as Record<string, unknown>;
  assert.equal(pinned.fetch_recipe_revision, 'fetch-synthetic/1');
  assert.equal(
    pinned.recipe_revision,
    undefined,
    'the build is not pinned yet',
  );
  context.db.sqlite
    .prepare(
      'UPDATE maintenance_tasks SET revision = revision + 1, outcome_json = ? WHERE id = ?',
    )
    .run(
      JSON.stringify({...pinned, fetch_recipe_revision: 'fetch-synthetic/0'}),
      id,
    );
  const next = await advance(context.db, context.github, id);
  assert.equal(next.state, 'blocked');
  assert.match(
    next.limitation!,
    /recipe changed from fetch-synthetic\/0 to fetch-synthetic\/1/,
  );
  assert.equal(context.gh.runs.size, 1, 'only the first fetch ran');
});

test('a task requested before tasks listed their steps is blocked, not guessed', async () => {
  const context = await setup();
  const old = {
    kind: 'prepare',
    inputs: [],
    operations: [],
    extent: {},
    capabilities: [],
    constraints: {recipe: 'synthetic'},
    decision_refs: [],
  };
  context.db.sqlite.exec('DROP TRIGGER maintenance_task_identity_stable');
  context.db.sqlite
    .prepare(
      'UPDATE maintenance_tasks SET revision = revision + 1, scope_json = ? WHERE id = ?',
    )
    .run(JSON.stringify(old), context.task.id);
  const result = await advance(context.db, context.github, context.task.id);
  assert.equal(result.state, 'blocked');
  assert.match(result.limitation!, /request it again/);
  assert.equal(context.gh.runs.size, 0);
});

test('a fetch recipe and a build recipe cannot be swapped, and a recipe does only one of them', async () => {
  const mixed = {
    ...recipe,
    units: [
      {unit_id: 'acquire', kind: 'acquire', native_extent: {}, depends_on: []},
      ...recipe.units,
    ],
  };
  const context = await setup({'collection/recipes/synthetic.json': mixed});
  const blocked = await advance(context.db, context.github, context.task.id);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.limitation!, /mixes fetch and build units/);
  assert.equal(context.gh.runs.size, 0);
  const swapped = await setup({'collection/recipes/synthetic.json': recipe});
  const fetch = await requestTask(swapped.db, owner, {
    request_key: 'f1',
    instruction: 'Fetch',
    steps: ['fetch'],
    inputs: [{kind: 'acquisition', id: 'route-1'}],
    extent: {units: ['u1', 'u2']},
    constraints: {fetch_recipe: 'synthetic'},
    decision_refs: [
      {kind: 'admission', ref: 'owner-decision:1', subject: 'route-1'},
    ],
  });
  assert.ok(fetch.status === 'created');
  const result = await advance(swapped.db, swapped.github, fetch.task.id);
  assert.equal(result.state, 'blocked');
  assert.match(result.limitation!, /nothing to fetch/);
  assert.equal(swapped.gh.runs.size, 0);
});
