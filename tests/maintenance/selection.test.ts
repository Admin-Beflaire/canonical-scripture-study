import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localD1 } from './d1.ts';
import { fakeGitHub } from './github.ts';
import { GitHubActions } from '../../services/maintenance/control/src/github.ts';
import { jobRoutes } from '../../services/maintenance/control/src/jobs.ts';
import { advance } from '../../services/maintenance/control/src/progress.ts';
import { membership, type ObjectStore } from '../../services/maintenance/control/src/selection.ts';
import { controlTask, requestTask, taskReport, type TaskRequest } from '../../services/maintenance/control/src/tasks.ts';
import type { JobInput } from '../../services/maintenance/control/src/contracts.ts';

/** MC-03: scope check, release construction and checked selection. Synthetic records only. */
const owner = 'owner@example.invalid';
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const C = 'synthetic-verses/1';

function recipeFor(id: string, units: string[][]) {
  const all = units.flat();
  return {
    recipe_version: 'preparation-recipe/1', id, revision: `${id}/r1`, manifest_revision: 'manifest-1',
    adapter: { name: 'synthetic-text', method_version: '1' }, input_format: 'synthetic/plain', parameters: {},
    native_extent: { book: id }, capabilities: ['source_context', 'word_exact'], dependencies: [],
    units: [
      { unit_id: 'acquire', kind: 'acquire', native_extent: {}, depends_on: [] },
      ...units.map((group, index) => ({ unit_id: `prepare-${index + 1}`, kind: 'prepare',
        native_extent: { coordinate_version: C, unit_ids: group }, depends_on: ['acquire'] })),
      { unit_id: 'quality', kind: 'quality', native_extent: { coordinate_version: C, unit_ids: all },
        depends_on: units.map((_, index) => `prepare-${index + 1}`), required_capabilities: ['source_context', 'word_exact'] },
    ],
  };
}

/** In-memory private bucket, listed two keys per page to exercise paging. */
function bucket() {
  const sizes = new Map<string, number>();
  const store: ObjectStore & { sizes: Map<string, number> } = {
    sizes,
    async list(prefix, cursor) {
      const keys = [...sizes.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2);
      return { objects: page.map(key => ({ key, size: sizes.get(key)! })), ...(start + 2 < keys.length ? { cursor: String(start + 2) } : {}) };
    },
  };
  return store;
}

function world() {
  const db = localD1();
  const objects = bucket();
  const recipes = {
    'collection/recipes/gen.json': recipeFor('gen', [['Gen.1.1', 'Gen.1.2'], ['Gen.1.3']]),
    'collection/recipes/exo.json': recipeFor('exo', [['Exo.1.1']]),
  };
  const gh = fakeGitHub({ recipes });
  const github = new GitHubActions({ repository: 'owner/app', token: 'synthetic-token' }, gh.fetcher);
  const routes = jobRoutes(db, github, objects);
  const post = async (path: string, body: unknown) => {
    const response = await routes(new Request(`https://control.example.invalid${path}`, { method: 'POST', body: JSON.stringify(body) }));
    return await response.json() as Record<string, unknown>;
  };
  source(db, 'rev-1');
  return { db, objects, gh, github, post };
}
type World = ReturnType<typeof world>;

function source(db: World['db'], revision: string, eligible = 1) {
  const insert = db.sqlite.prepare('INSERT OR IGNORE INTO source_nodes VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(`${revision}:work`, 'work', null, 'Synthetic work', 'Synthetic attribution', 'synthetic', '{}');
  insert.run(`${revision}:edition`, 'edition', `${revision}:work`, 'Synthetic edition', 'Synthetic attribution', 'synthetic', '{}');
  insert.run(`${revision}:repr`, 'representation', `${revision}:edition`, 'Synthetic text', 'Synthetic attribution', 'synthetic', '{}');
  insert.run(revision, 'source_revision', `${revision}:repr`, 'Synthetic revision', 'Synthetic attribution', 'synthetic', '{}');
  db.sqlite.prepare(`INSERT OR IGNORE INTO admissions VALUES (?, ?, 'component-1', 'synthetic terms', '[]', '[]', '[]', ?, 'not_allowed')`)
    .run(`${revision}:component-1`, revision, eligible);
}

/** What Preparation saves for one prepare unit: an evidence output with a body artifact in the
 *  bucket, and an index output depending on it, with available coverage. */
type Damage = { format?: string; skipWordCoverage?: string };
function savePrepared(w: World, revision: string, unit: string, units: string[], tag = '', damage: Damage = {}) {
  const extent = JSON.stringify({ coordinate_version: C, unit_ids: units });
  const evidence = `evidence:${sha(revision + unit + tag).slice(0, 32)}`;
  const index = `source_search:${sha(revision + unit + tag + 'i').slice(0, 32)}`;
  const insert = w.db.sqlite.prepare('INSERT INTO prepared_outputs VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(evidence, 'evidence', JSON.stringify([revision]), 'm1', '{}', extent, JSON.stringify({ reuse_basis: 'x', dependencies: [] }));
  insert.run(index, 'source_search', JSON.stringify([revision]), 'm1', '{}', extent, JSON.stringify({ reuse_basis: 'y', dependencies: [evidence] }));
  const refs = [];
  for (const [output, format] of [[evidence, 'text/utf-8'], [index, damage.format ?? 'application/x-ndjson']]) {
    const digest = sha(output);
    const locator = `prepared/${digest}/file`;
    w.db.sqlite.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, 10, ?, ?)').run(`artifact-${output}`, revision, output, digest, format, locator);
    w.objects.sizes.set(locator, 10);
    refs.push({ artifact_id: `artifact-${output}`, sha256: digest, byte_count: 10 });
  }
  const coverage = w.db.sqlite.prepare(`INSERT INTO coverage VALUES (?, ?, ?, ?, 'available', 'm1', NULL, '[]', NULL)`);
  coverage.run(evidence, revision, extent, 'source_context');
  if (!units.includes(damage.skipWordCoverage ?? '')) coverage.run(index, revision, extent, 'word_exact');
  return { outputs: [evidence, index], refs };
}

function prepareTask(book: 'gen' | 'exo', key: string, extra: Partial<TaskRequest> = {}): TaskRequest {
  return { request_key: key, instruction: `Load ${book}`, kind: 'prepare', inputs: [{ kind: 'source_revision', id: 'rev-1' }],
    extent: { book }, capabilities: ['source_context', 'word_exact'], constraints: { recipe: book }, ...extra };
}

function latestRun(w: World, unit: string, taskId: string) {
  const runs = [...w.gh.runs.values()].filter(run => {
    const job = JSON.parse(run.job) as JobInput;
    return job.unit_id === unit && job.task_id === taskId;
  });
  const run = runs[runs.length - 1];
  return { run, job: JSON.parse(run.job) as JobInput, text: run.job };
}

async function report(w: World, taskId: string, unit: string, overrides: Record<string, unknown> = {}) {
  const { run, job, text } = latestRun(w, unit, taskId);
  await w.post('/internal/jobs/state', { task_id: taskId, unit_id: unit, attempt: job.attempt, run_id: String(run.id), job_input_basis: sha(text) });
  const result = { contract_version: 'maintenance-job/1', task_id: taskId, task_revision: job.task_revision, unit_id: unit, attempt: job.attempt,
    basis_digest: job.basis_digest, run_id: String(run.id), completed_extent: job.native_extent, remaining_extent: {}, output_refs: [],
    coverage_refs: [], checkpoint_ref: null, quality_receipt_ref: null, state: 'succeeded', diagnostics: [], ...overrides };
  const reply = await w.post('/internal/jobs/result', { result, commit: w.gh.commit });
  run.status = 'completed';
  return reply;
}

/** Run a whole book task: acquire, prepare units (saving their records), quality with a receipt. */
async function runBook(w: World, request: TaskRequest, revision = 'rev-1', options: { tag?: string; beforeQuality?: () => void; damage?: Damage } = {}) {
  const created = await requestTask(w.db, owner, request);
  assert.equal(created.status, 'created', JSON.stringify(created));
  const taskId = (created as { task: { id: string } }).task.id;
  await advance(w.db, w.github, taskId, w.objects);
  await report(w, taskId, 'acquire');
  const recipe = JSON.parse(await (await w.github.readFile(`collection/recipes/${(request.constraints as { recipe: string }).recipe}.json`))!) as ReturnType<typeof recipeFor>;
  const refs = [];
  for (const unit of recipe.units.filter(item => item.kind === 'prepare')) {
    const saved = savePrepared(w, revision, unit.unit_id + (request.constraints as { recipe: string }).recipe,
      unit.native_extent.unit_ids as string[], options.tag, options.damage);
    refs.push(...saved.refs);
    await report(w, taskId, unit.unit_id, { output_refs: saved.refs });
  }
  options.beforeQuality?.();
  await report(w, taskId, 'quality', { output_refs: refs, quality_receipt_ref: { artifact_id: 'receipt', sha256: sha(taskId), byte_count: 99 } });
  return { taskId, task: (await taskReport(w.db, owner, taskId))! };
}

const selected = (w: World) => ({ ...w.db.sqlite.prepare('SELECT current_release_id, previous_release_id FROM release_selection').get() }) as
  { current_release_id: string | null; previous_release_id: string | null };
const membersOf = (w: World, release: string | null) => (w.db.sqlite.prepare('SELECT output_id FROM release_outputs WHERE release_id = ? ORDER BY output_id')
  .all(release) as Array<{ output_id: string }>).map(row => row.output_id);

test('a checked candidate becomes current in one guarded selection; the first promotion has no base', async () => {
  const w = world();
  const { task } = await runBook(w, prepareTask('gen', 'g1'));
  assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  assert.equal(task.checks.quality, 'passed');
  assert.equal(task.checks.scope, 'passed');
  assert.ok(task.checks.scope_receipt?.startsWith('sha256:'));
  assert.equal(task.data_current, true);
  const now = selected(w);
  assert.equal(now.current_release_id, task.selection.candidate_release_id);
  assert.equal(now.previous_release_id, null);
  assert.equal(task.selection.base_release_id, null);
  assert.equal(membersOf(w, now.current_release_id).length, 4);
  const release = w.db.sqlite.prepare('SELECT * FROM releases').get() as Record<string, string>;
  assert.equal(release.recipe_revision, 'gen/r1');
  assert.equal(release.quality_receipt, `receipt@${sha(task.id)}`);
});

test('a second book is added to the current release; parallel tasks each rebuild from current at check time', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  const second = await runBook(w, prepareTask('exo', 'e1'));
  assert.equal(second.task.state, 'completed');
  const now = selected(w);
  assert.equal(now.previous_release_id, first.task.selection.candidate_release_id);
  assert.equal(second.task.selection.base_release_id, first.task.selection.candidate_release_id);
  assert.equal(membersOf(w, now.current_release_id).length, 6, 'Genesis kept, Exodus added');
});

test('re-preparing a book replaces its overlapping outputs and keeps the rest', async () => {
  const w = world();
  await runBook(w, prepareTask('exo', 'e1'));
  const before = membersOf(w, selected(w).current_release_id);
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('gen', 'g2', { kind: 'correct' }), 'rev-1', { tag: 'corrected' });
  const after = membersOf(w, selected(w).current_release_id);
  assert.equal(after.length, 6);
  for (const id of before) assert.ok(after.includes(id), 'Exodus untouched');
  const genesis = after.filter(id => !before.includes(id));
  const corrected = (w.db.sqlite.prepare(`SELECT id FROM prepared_outputs WHERE id IN (${genesis.map(() => '?').join(',')})`).all(...genesis) as Array<{ id: string }>);
  assert.equal(corrected.length, 4, 'the four corrected Genesis outputs replace the old four');
});

test('scope failures leave the current release unchanged and block the task', async () => {
  const cases: Array<[string, { damage?: Damage; beforeQuality?: (w: World) => void; revision?: string }, string]> = [
    ['missing object', { beforeQuality: w => w.objects.sizes.clear() }, 'missing from storage'],
    ['wrong size', { beforeQuality: w => { for (const key of w.objects.sizes.keys()) w.objects.sizes.set(key, 11); } }, 'bytes'],
    ['not admitted', { revision: 'rev-na' }, 'not admitted for both hosts'],
    ['partial coverage', { damage: { skipWordCoverage: 'Gen.1.3' } }, 'word_exact is not available'],
    ['unsupported format', { damage: { format: 'image/png' } }, 'unsupported format'],
  ];
  for (const [name, options, expected] of cases) {
    const w = world();
    const revision = options.revision ?? 'rev-1';
    if (revision !== 'rev-1') source(w.db, revision, 0);
    const request = prepareTask('gen', 'g1', { inputs: [{ kind: 'source_revision', id: revision }],
      decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: revision }] });
    const { taskId } = await runBook(w, request, revision, { damage: options.damage, beforeQuality: () => options.beforeQuality?.(w) });
    const task = (await taskReport(w.db, owner, taskId))!;
    assert.equal(task.state, 'blocked', name);
    assert.equal(task.checks.scope, 'failed', name);
    assert.ok(task.limitations.some(text => text.includes(expected)), `${name}: ${task.limitations.join(' | ')}`);
    assert.equal(selected(w).current_release_id, null, name);
    assert.equal(w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM releases').get()?.n, 0, name);
  }
});

test('outputs from a source revision the task does not name fail the scope check', async () => {
  const w = world();
  source(w.db, 'rev-other');
  const { taskId } = await runBook(w, prepareTask('gen', 'g1'), 'rev-other');
  const task = (await taskReport(w.db, owner, taskId))!;
  assert.equal(task.state, 'blocked');
  assert.ok(task.limitations.some(text => text.includes('which the task does not name')));
});

test('the task must ask for the recipe extent and capabilities before anything is dispatched', async () => {
  const w = world();
  const cases: Array<[string, Partial<TaskRequest>, string]> = [['x1', { extent: { book: 'exo' } }, "recipe's extent"], ['x2', { capabilities: ['lemma_exact'] }, 'does not provide']];
  for (const [key, change, text] of cases) {
    const created = await requestTask(w.db, owner, prepareTask('gen', key, change));
    const id = (created as { task: { id: string } }).task.id;
    const progress = await advance(w.db, w.github, id, w.objects);
    assert.equal(progress.state, 'blocked');
    assert.ok(progress.limitation?.includes(text));
  }
  assert.equal(w.gh.runs.size, 0);
});

test('a changed current release between check and selection fails the guard; the next check rebuilds', async () => {
  const w = world();
  await runBook(w, prepareTask('exo', 'e1'));
  const exodus = selected(w).current_release_id;
  // Promote Genesis, but let another selection land between the check batch and the selection batch.
  const batch = w.db.batch.bind(w.db);
  let interfered = false;
  w.db.batch = async statements => {
    if (!interfered) {
      const state = w.db.sqlite.prepare(`SELECT state FROM maintenance_tasks WHERE request_key = 'g1'`).get() as { state: string } | undefined;
      if (state?.state === 'checked') {
        interfered = true;
        w.db.sqlite.exec(`INSERT INTO releases VALUES ('release-other', 'm', 'r', '{}', 'c', 'q', 's');
          INSERT INTO release_outputs SELECT 'release-other', output_id FROM release_outputs WHERE release_id = '${exodus}';
          UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = 'release-other'`);
      }
    }
    return batch(statements);
  };
  const { taskId } = await runBook(w, prepareTask('gen', 'g1'));
  assert.ok(interfered);
  let task = (await taskReport(w.db, owner, taskId))!;
  assert.equal(task.state, 'checked', 'guard failed: checked but not current');
  assert.equal(selected(w).current_release_id, 'release-other');
  // The next check (for example get_task) rebuilds from the new current release and selects.
  await advance(w.db, w.github, taskId, w.objects);
  task = (await taskReport(w.db, owner, taskId))!;
  assert.equal(task.state, 'completed');
  assert.equal(task.selection.base_release_id, 'release-other');
  assert.equal(selected(w).previous_release_id, 'release-other');
});

test('a lost selection response is settled by reading the selection back', async () => {
  const w = world();
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async statements => {
    const result = await batch(statements);
    const state = w.db.sqlite.prepare(`SELECT state FROM maintenance_tasks WHERE request_key = 'g1'`).get() as { state: string } | undefined;
    if (state?.state === 'completed') throw new Error('connection lost after commit');
    return result;
  };
  const { task } = await runBook(w, prepareTask('gen', 'g1'));
  assert.equal(task.state, 'completed');
  assert.equal(selected(w).current_release_id, task.selection.candidate_release_id);
});

test('pause and cancel stop promotion; resume runs the check again', async () => {
  const w = world();
  const created = await requestTask(w.db, owner, prepareTask('gen', 'g1'));
  const id = (created as { task: { id: string } }).task.id;
  await advance(w.db, w.github, id, w.objects);
  await report(w, id, 'acquire');
  const refs = [];
  for (const unit of ['prepare-1', 'prepare-2']) {
    const saved = savePrepared(w, 'rev-1', unit, unit === 'prepare-1' ? ['Gen.1.1', 'Gen.1.2'] : ['Gen.1.3']);
    refs.push(...saved.refs);
    await report(w, id, unit, { output_refs: saved.refs });
  }
  const paused = (await taskReport(w.db, owner, id))!;
  assert.equal((await controlTask(w.db, owner, id, paused.revision, 'pause')).status, 'ok');
  await report(w, id, 'quality', { output_refs: refs, quality_receipt_ref: { artifact_id: 'receipt', sha256: sha(id), byte_count: 99 } });
  assert.equal((await taskReport(w.db, owner, id))!.state, 'paused');
  assert.equal(selected(w).current_release_id, null, 'paused work is not promoted');
  const now = (await taskReport(w.db, owner, id))!;
  assert.equal((await controlTask(w.db, owner, id, now.revision, 'resume')).status, 'ok');
  await advance(w.db, w.github, id, w.objects);
  assert.equal((await taskReport(w.db, owner, id))!.state, 'completed');
});

test('rollback validates the previous release and selects it through the same gate', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const second = selected(w).current_release_id;
  const created = await requestTask(w.db, owner, { request_key: 'rb1', instruction: 'Roll back', kind: 'rollback' });
  const id = (created as { task: { id: string } }).task.id;
  await advance(w.db, w.github, id, w.objects);
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.state, 'completed');
  assert.equal(task.data_current, true);
  assert.deepEqual(selected(w), { current_release_id: first.task.selection.candidate_release_id, previous_release_id: second });
});

test('rollback without an eligible previous release reports a limitation and changes nothing', async () => {
  const w = world();
  const none = await requestTask(w.db, owner, { request_key: 'rb0', instruction: 'Roll back', kind: 'rollback' });
  await advance(w.db, w.github, (none as { task: { id: string } }).task.id, w.objects);
  let task = (await taskReport(w.db, owner, (none as { task: { id: string } }).task.id))!;
  assert.ok(task.limitations.some(text => text.includes('No previous release')));
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const before = selected(w);
  for (const key of [...w.objects.sizes.keys()].filter(key => membersOf(w, before.previous_release_id).some(id => key.includes(sha(id))))) w.objects.sizes.delete(key);
  const created = await requestTask(w.db, owner, { request_key: 'rb1', instruction: 'Roll back', kind: 'rollback' });
  const id = (created as { task: { id: string } }).task.id;
  await advance(w.db, w.github, id, w.objects);
  task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.data_current, false);
  assert.ok(task.limitations.some(text => text.includes('not eligible')));
  assert.deepEqual(selected(w), before);
});

test('removal drops a source, records the exclusion, and later candidates of that source are refused', async () => {
  const w = world();
  source(w.db, 'rev-2');
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1', { inputs: [{ kind: 'source_revision', id: 'rev-2' }] }), 'rev-2');
  assert.equal(membersOf(w, selected(w).current_release_id).length, 6);
  const created = await requestTask(w.db, owner, { request_key: 'rm1', instruction: 'Remove the second source', kind: 'remove',
    inputs: [{ kind: 'source_revision', id: 'rev-2' }], decision_refs: [{ kind: 'exclusion', ref: 'owner-decision:7', subject: 'rev-2' }] });
  const id = (created as { task: { id: string } }).task.id;
  await advance(w.db, w.github, id, w.objects);
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  assert.equal(membersOf(w, selected(w).current_release_id).length, 4);
  assert.equal(w.db.sqlite.prepare(`SELECT active FROM maintenance_exclusions WHERE source_or_component_id = 'rev-2'`).get()?.active, 1);
  // The exclusion survives: preparing that source again is refused, and so is rolling back to it.
  const again = await runBook(w, prepareTask('exo', 'e2', { inputs: [{ kind: 'source_revision', id: 'rev-2' }] }), 'rev-2', { tag: 'again' });
  assert.equal(again.task.state, 'blocked');
  assert.ok(again.task.limitations.some(text => text.includes('excluded by the owner')));
  const rollback = await requestTask(w.db, owner, { request_key: 'rb1', instruction: 'Roll back', kind: 'rollback' });
  const rollbackId = (rollback as { task: { id: string } }).task.id;
  await advance(w.db, w.github, rollbackId, w.objects);
  assert.equal((await taskReport(w.db, owner, rollbackId))!.data_current, false);
  // Only an explicit owner exclusion decision on a task that adds the source lifts it.
  const lifted = await runBook(w, prepareTask('exo', 'e3', { inputs: [{ kind: 'source_revision', id: 'rev-2' }],
    decision_refs: [{ kind: 'exclusion', ref: 'owner-decision:8', subject: 'rev-2' }] }), 'rev-2', { tag: 'lifted' });
  assert.equal(lifted.task.state, 'completed', JSON.stringify(lifted.task.limitations));
  assert.equal(w.db.sqlite.prepare(`SELECT active FROM maintenance_exclusions WHERE source_or_component_id = 'rev-2'`).get()?.active, 0);
});

test('restore validation blocks restored open work and selects a restored release only when instructed', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const open = await requestTask(w.db, owner, prepareTask('gen', 'g9', { kind: 'correct' }));
  const openId = (open as { task: { id: string } }).task.id;
  await advance(w.db, w.github, openId, w.objects);
  const check = await requestTask(w.db, owner, { request_key: 'vr1', instruction: 'Check the restore', kind: 'validate_restore' });
  const checkId = (check as { task: { id: string } }).task.id;
  await advance(w.db, w.github, checkId, w.objects);
  const report1 = (await taskReport(w.db, owner, checkId))!;
  assert.equal(report1.state, 'completed');
  assert.ok(report1.limitations.includes('The restored releases passed validation.'));
  assert.equal(report1.data_current, false);
  assert.equal((await taskReport(w.db, owner, openId))!.state, 'blocked', 'restored running work is not restarted');
  const select = await requestTask(w.db, owner, { request_key: 'vr2', instruction: 'Select the first release',
    kind: 'validate_restore', constraints: { select_release: first.task.selection.candidate_release_id } });
  const selectId = (select as { task: { id: string } }).task.id;
  await advance(w.db, w.github, selectId, w.objects);
  assert.equal((await taskReport(w.db, owner, selectId))!.data_current, true);
  assert.equal(selected(w).current_release_id, first.task.selection.candidate_release_id);
});

test('membership keeps unrelated outputs, replaces overlapping ones and refuses orphaned dependants', () => {
  const output = (id: string, kind: string, revision: string, units: string[], dependencies: string[] = []) =>
    ({ id, kind, revisions: [revision], extent: { coordinate_version: C, unit_ids: units }, dependencies });
  const base = [output('e1', 'evidence', 'r', ['a', 'b']), output('i1', 'source_search', 'r', ['a', 'b'], ['e1']),
    output('e2', 'evidence', 'r', ['c']), output('x1', 'evidence', 'other', ['a'])];
  const fresh = [output('e3', 'evidence', 'r', ['b']), output('i3', 'source_search', 'r', ['b'], ['e3'])];
  const built = membership(base, fresh, new Set(), new Set());
  assert.deepEqual(built.ids, ['e2', 'e3', 'i3', 'x1']);
  assert.deepEqual(built.problems, []);
  const orphan = membership(base, [output('e4', 'evidence', 'r', ['a'])], new Set(), new Set());
  // e4 replaces e1, but the kept index i1 still depends on e1: refused.
  assert.ok(orphan.problems.some(text => text.includes('i1')));
  assert.deepEqual(membership(base, [], new Set(), new Set(['r'])).ids, ['x1']);
});
