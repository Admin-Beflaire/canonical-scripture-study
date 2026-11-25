import {reportError} from '../../../../packages/shared/src/error-record.ts';
import {canonicalJson, type D1Database} from './d1.ts';
import {
  recipeErrors,
  type ArtifactRef,
  type JobResult,
  type Recipe,
  type RecipeUnit,
} from './contracts.ts';
import {tidyReleases} from './cleanup.ts';
import {dispatchUnit, type DispatchResult, type UnitPlan} from './dispatch.ts';
import {
  FileEncodingError,
  GitHubError,
  runTitle,
  type GitHubActions,
} from './github.ts';
import {
  checkAndSelect,
  releaseCandidate,
  selectDirect,
  type ObjectStore,
} from './selection.ts';
import {
  ALONE_STEPS,
  OPEN_STATES,
  TASK_STATES,
  has,
  type Outcome,
  type Scope,
  type TaskRow,
} from './tasks.ts';

/** Task progression without an open chat (Maintenance Control To-Be §2–3, MC-02).
 *  The recipe's units are Data Preparation's partition; Control only reads them, dispatches
 *  ready units and reconciles interrupted ones. When every unit has succeeded, the scope check
 *  and conditional selection follow (selection.ts, MC-03). */
export const MAX_ATTEMPTS = 3;
const ACTIVE = new Set(['intended', 'dispatched', 'running']);
const OPEN = new Set<string>(OPEN_STATES);
const ENDED = new Set<string>(TASK_STATES.filter(state => !OPEN.has(state)));
const RETRYABLE = new Set(['failed', 'cancelled']);

interface JobView {
  unit_id: string;
  attempt: number;
  kind: string;
  state: string;
  run_id: string | null;
  result_json: string | null;
  input_basis?: string;
}
export type Progress = {
  dispatched: string[];
  state: string;
  limitation?: string;
};

/** Read and check the recipe named in the task, from reviewed main. */
export async function loadRecipe(
  github: GitHubActions,
  id: unknown,
): Promise<{recipe?: Recipe; problem?: string}> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(id))
    return {problem: 'constraints.recipe must name a reviewed recipe'};
  let text: string | null;
  try {
    text = await github.readFile(`collection/recipes/${id}.json`);
  } catch (error) {
    if (error instanceof FileEncodingError)
      return {problem: `recipe ${id} is not valid UTF-8`};
    throw error;
  }
  if (text === null) return {problem: `recipe ${id} is not on main`};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {problem: `recipe ${id} is not valid JSON`};
  }
  const errors = recipeErrors(value);
  if (errors.length)
    return {
      problem: `recipe ${id} is invalid: ${errors.slice(0, 3).join('; ')}`,
    };
  const recipe = value as Recipe;
  if (!recipe.units || !recipe.manifest_revision)
    return {
      problem: `recipe ${id} has no units or manifest revision to dispatch`,
    };
  const seen = new Set<string>();
  for (const unit of recipe.units) {
    // Units are listed in dependency order, which also rules out cycles.
    if (
      seen.has(unit.unit_id) ||
      !unit.depends_on.every(dependency => seen.has(dependency))
    )
      return {
        problem: `recipe ${id} unit ${unit.unit_id} is duplicated or depends on a later unit`,
      };
    seen.add(unit.unit_id);
  }
  // A recipe says how to do one step for its source: it fetches or it builds, never both.
  const fetches = recipe.units.filter(unit => unit.kind === 'acquire').length;
  if (fetches && fetches !== recipe.units.length)
    return {
      problem: `recipe ${id} mixes fetch and build units; a recipe does only one of them`,
    };
  return {recipe};
}

async function task(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM maintenance_tasks WHERE id = ?')
    .bind(id)
    .first<TaskRow>();
}

/** Every task change advances its revision (a database rule), so unchanged outcomes are not
 *  rewritten. Notes are written only when no unit is running, except a block, which stops work. */
async function setOutcome(
  db: D1Database,
  row: TaskRow,
  change: (outcome: Outcome) => void,
  state?: 'blocked',
) {
  const outcome = JSON.parse(row.outcome_json) as Outcome;
  change(outcome);
  const text = canonicalJson(outcome);
  if (!state && text === canonicalJson(JSON.parse(row.outcome_json))) return;
  const sql = state
    ? `UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1, outcome_json = ? WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`
    : `UPDATE maintenance_tasks SET revision = revision + 1, outcome_json = ? WHERE id = ? AND revision = ?`;
  await db.prepare(sql).bind(text, row.id, row.revision).run();
}

function addLimitation(outcome: Outcome, text: string) {
  if (!outcome.limitations.includes(text)) outcome.limitations.push(text);
}

/** Move a task on, then clear what its end left behind (release cleanup, see cleanup.ts). */
export async function advance(
  db: D1Database,
  github: GitHubActions | null,
  taskId: string,
  objects: ObjectStore | null = null,
): Promise<Progress> {
  const progress = await advanceTask(db, github, taskId, objects);
  if (ENDED.has(progress.state)) await tidyReleases(db, objects);
  return progress;
}

const stop = (state: string, limitation?: string, dispatched: string[] = []) =>
  ({dispatched, state, ...(limitation ? {limitation} : {})}) as Progress;
const resultOf = (done: {state: string; limitation?: string}): Progress =>
  stop(done.state, done.limitation);

/** Block the task with a reason; the current data stays unchanged. */
async function blockWith(
  db: D1Database,
  taskId: string,
  problem: string,
  dispatched: string[] = [],
): Promise<Progress> {
  await setOutcome(
    db,
    (await task(db, taskId))!,
    outcome => addLimitation(outcome, problem),
    'blocked',
  );
  return stop('blocked', problem, dispatched);
}

/** One task, one request: the steps it lists run in order, each only if the task names it. */
async function advanceTask(
  db: D1Database,
  github: GitHubActions | null,
  taskId: string,
  objects: ObjectStore | null,
): Promise<Progress> {
  const row = await task(db, taskId);
  if (!row) return stop('unknown');
  if (!['queued', 'running', 'checked'].includes(row.state))
    return stop(row.state);
  const scope = JSON.parse(row.scope_json) as Scope;
  if (!Array.isArray(scope.steps))
    return blockWith(
      db,
      taskId,
      'This task was requested before tasks listed their steps; request it again.',
    );
  if (ALONE_STEPS.some(step => has(scope, step))) {
    // Removal, rollback and restore validation prepare nothing: they go straight to the checks and gate.
    return resultOf(await selectDirect(db, objects, row));
  }
  if (!has(scope, 'fetch') && !has(scope, 'build'))
    // Make a finished build's checked candidate current; no work is dispatched.
    return selectStep(db, objects, row);
  if (!github) {
    await setOutcome(db, row, outcome =>
      addLimitation(
        outcome,
        'Preparation dispatch is not configured for Control.',
      ),
    );
    return stop(row.state, 'dispatch_not_configured');
  }
  return runRecipes({db, github, taskId, scope, objects});
}

interface Run {
  db: D1Database;
  github: GitHubActions;
  taskId: string;
  scope: Scope;
  objects: ObjectStore | null;
}
type Which = 'fetch' | 'build';
const PIN: Record<Which, 'fetch_recipe_revision' | 'recipe_revision'> = {
  fetch: 'fetch_recipe_revision',
  build: 'recipe_revision',
};

/** The select step: make a finished build's checked candidate current. */
async function selectStep(
  db: D1Database,
  objects: ObjectStore | null,
  row: TaskRow,
): Promise<Progress> {
  return resultOf(await releaseCandidate(db, objects, row));
}

/** The steps the task lists, in order: fetch, then build, then select. Each runs only when listed;
 *  a step that has more steps after it hands on to the next one instead of completing the task. */
async function runRecipes(run: Run): Promise<Progress> {
  const fetched = has(run.scope, 'fetch') ? await fetchStep(run) : null;
  if (fetched) return fetched;
  if (has(run.scope, 'build')) return buildStep(run);
  return selectStep(run.db, run.objects, (await task(run.db, run.taskId))!);
}

/** The reviewed recipe for one step, pinned to the revision this task started with. */
async function pinnedRecipe(
  run: Run,
  which: Which,
): Promise<{recipe: Recipe} | {done: Progress}> {
  const {db, github, taskId, scope} = run;
  const row = (await task(db, taskId))!;
  let loaded: Awaited<ReturnType<typeof loadRecipe>>;
  try {
    loaded = await loadRecipe(
      github,
      scope.constraints[which === 'fetch' ? 'fetch_recipe' : 'recipe'],
    );
  } catch (error) {
    // A temporary GitHub failure postpones progression; it never blocks the task.
    if (!(error instanceof GitHubError)) throw error;
    reportError(error, {
      tool: 'control',
      stage: 'load_recipe',
      code: 'github_unavailable',
      outcome: 'uncertain',
      ids: {task: taskId},
    });
    return {done: stop(row.state, 'github_unavailable')};
  }
  const {recipe, problem: invalid} = loaded;
  const pinned = (JSON.parse(row.outcome_json) as Outcome)[PIN[which]];
  const changed =
    recipe && pinned && pinned !== recipe.revision
      ? `recipe changed from ${pinned} to ${recipe.revision}; start a new task for the changed recipe`
      : undefined;
  const problem =
    invalid ?? (recipe ? recipeFit(scope, recipe, which) : undefined);
  if (problem || changed)
    return {done: await blockWith(db, taskId, (problem ?? changed)!)};
  if (!pinned)
    await setOutcome(db, row, outcome => {
      outcome[PIN[which]] = recipe!.revision;
    });
  // Work only under the pin that is actually saved: a concurrent first advance may have
  // pinned a different recipe revision.
  const now = (await task(db, taskId))!;
  return (JSON.parse(now.outcome_json) as Outcome)[PIN[which]] ===
    recipe!.revision
    ? {recipe: recipe!}
    : {done: stop(now.state)};
}

/** Results of the units that have succeeded, by unit. */
async function succeededUnits(db: D1Database, taskId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT unit_id, result_json FROM maintenance_jobs WHERE task_id = ? AND state = 'succeeded' AND result_json IS NOT NULL ORDER BY unit_id, attempt`,
      )
      .bind(taskId)
      .all<{unit_id: string; result_json: string}>()
  ).results;
  const done = new Map<string, JobResult>();
  for (const job of rows)
    if (!done.has(job.unit_id))
      done.set(job.unit_id, JSON.parse(job.result_json) as JobResult);
  return done;
}

const pinnedTo = (recipe: Recipe, which: Which) => (current: TaskRow) =>
  (JSON.parse(current.outcome_json) as Outcome)[PIN[which]] === recipe.revision;

/** What one unit needs next: nothing yet (done, running or waiting for others), a block, or a dispatch. */
function unitStatus(
  unit: RecipeUnit,
  attempts: JobView[],
  succeeded: Map<string, JobResult>,
): 'wait' | 'exhausted' | 'dispatch' {
  const latest = attempts[attempts.length - 1];
  if (succeeded.has(unit.unit_id) || (latest && ACTIVE.has(latest.state)))
    return 'wait';
  if (
    latest &&
    (inputProblem(latest) ||
      (RETRYABLE.has(latest.state) && attempts.length >= MAX_ATTEMPTS))
  )
    return 'exhausted';
  return unit.depends_on.every(dependency => succeeded.has(dependency))
    ? 'dispatch'
    : 'wait';
}

/** Start one ready unit. `halt` ends this pass; a `problem` blocks the task. */
async function startUnit(
  run: Run,
  recipe: Recipe,
  which: Which,
  unit: RecipeUnit,
  succeeded: Map<string, JobResult>,
): Promise<{dispatched?: string; halt?: boolean; problem?: string}> {
  const {db, github, taskId} = run;
  const plan = await unitPlan(db, recipe, unit, succeeded);
  if ('problem' in plan) return {problem: plan.problem};
  const row = (await task(db, taskId))!;
  if (
    !['queued', 'running'].includes(row.state) ||
    !pinnedTo(recipe, which)(row)
  )
    return {halt: true};
  const result: DispatchResult = await dispatchUnit(
    db,
    github,
    taskId,
    row.revision,
    plan,
  );
  // The task stopped while the run was starting: it has no job record, so stop it now. If that
  // fails, the runner still refuses at its first Control check because no dispatch is recorded.
  if (result.status === 'orphaned') await github.cancel(result.run_id);
  return {
    ...(result.status === 'dispatched' ? {dispatched: unit.unit_id} : {}),
    halt: ['uncertain', 'not_dispatchable', 'orphaned'].includes(result.status),
  };
}

/** Dispatch every unit of one recipe whose dependencies have succeeded; safe to repeat. Returns
 *  the units' results once all have succeeded, otherwise where the task stands. */
async function runUnits(
  run: Run,
  recipe: Recipe,
  which: Which,
): Promise<{succeeded: Map<string, JobResult>} | {done: Progress}> {
  const {db, taskId} = run;
  const jobs = (
    await db
      .prepare(
        'SELECT unit_id, attempt, kind, state, run_id, result_json FROM maintenance_jobs WHERE task_id = ? ORDER BY unit_id, attempt',
      )
      .bind(taskId)
      .all<JobView>()
  ).results;
  const succeeded = await succeededUnits(db, taskId);
  const dispatched: string[] = [];
  for (const unit of recipe.units!) {
    const attempts = jobs.filter(job => job.unit_id === unit.unit_id);
    const status = unitStatus(unit, attempts, succeeded);
    if (status === 'wait') continue;
    if (status === 'exhausted')
      return {
        done: await blockWith(
          db,
          taskId,
          exhausted(unit, attempts[attempts.length - 1]),
          dispatched,
        ),
      };
    const started = await startUnit(run, recipe, which, unit, succeeded);
    if (started.problem)
      return {done: await blockWith(db, taskId, started.problem, dispatched)};
    if (started.dispatched) dispatched.push(started.dispatched);
    if (started.halt) break;
  }
  const row = (await task(db, taskId))!;
  const ready =
    recipe.units!.every(unit => succeeded.has(unit.unit_id)) &&
    ['queued', 'running', 'checked'].includes(row.state) &&
    pinnedTo(recipe, which)(row);
  return ready ? {succeeded} : {done: stop(row.state, undefined, dispatched)};
}

/** What the runner said when a task's input is not saved as named: retrying cannot change that. */
function inputProblem(job: JobView): string | null {
  if (!job.result_json) return null;
  let found: {code: string; message: string} | undefined;
  try {
    found = (JSON.parse(job.result_json) as JobResult).diagnostics.find(
      diagnostic => diagnostic.code === 'input_not_registered',
    );
    if (!found) return null;
    const {message} = JSON.parse(found.message) as {message?: unknown};
    return typeof message === 'string' ? message : 'an input is not registered';
  } catch {
    return found ? 'an input is not registered' : null;
  }
}

const exhausted = (unit: RecipeUnit, latest: JobView) => {
  const input = inputProblem(latest);
  if (input)
    return `unit ${unit.unit_id} cannot run: ${input}. Check the task's input IDs against an earlier task for the same source and request it again`;
  const codes = latest.result_json
    ? (JSON.parse(latest.result_json) as JobResult).diagnostics
        .map(d => d.code)
        .join(', ')
    : 'no result';
  return `unit ${unit.unit_id} did not succeed in ${MAX_ATTEMPTS} attempts (${codes || 'no diagnostics'})`;
};

/** Fetch step: keep the original. Alone it ends the task; before a build it only prepares the way,
 *  and the result is null once the original is kept. */
async function fetchStep(run: Run): Promise<Progress | null> {
  const {db, taskId, scope} = run;
  const pinned = await pinnedRecipe(run, 'fetch');
  if ('done' in pinned) return pinned.done;
  const ran = await runUnits(run, pinned.recipe, 'fetch');
  if ('done' in ran) return ran.done;
  if (!(await acquisitionRecorded(db, scope, pinned.recipe)))
    return blockWith(
      db,
      taskId,
      'The acquired original and its admission were not recorded.',
    ).then(blocked => ({...blocked, limitation: 'acquisition_not_recorded'}));
  if (has(scope, 'build')) return null; // the build step records the extent
  const row = (await task(db, taskId))!;
  if (has(scope, 'select')) {
    // The fetch is done; record it before the select step follows.
    await setOutcome(db, row, outcome => {
      outcome.completed_extent = scope.extent;
      outcome.remaining_extent = {};
    });
    return null;
  }
  const outcome = JSON.parse(row.outcome_json) as Outcome;
  outcome.completed_extent = scope.extent;
  outcome.remaining_extent = {};
  await db
    .prepare(
      `UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
    WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`,
    )
    .bind(canonicalJson(outcome), taskId, row.revision)
    .run();
  return stop((await task(db, taskId))?.state ?? 'unknown');
}

/** An acquire-only recipe fetches one opaque original under the name of the source revision it makes. */
function acquireOnlyRevision(scope: Scope, recipe: Recipe): string | null {
  const [unit] = recipe.units!;
  const revision = recipe.native_extent?.component;
  const permitted =
    recipe.units!.length === 1 &&
    unit.unit_id === 'acquire' &&
    unit.depends_on.length === 0 &&
    canonicalJson(unit.native_extent) === canonicalJson(recipe.native_extent) &&
    typeof revision === 'string' &&
    scope.inputs.some(
      ref => ref.kind === 'source_revision' && ref.id === revision,
    ) &&
    scope.inputs.some(
      ref => ref.kind === 'acquisition' && ref.id === recipe.manifest_revision,
    );
  return permitted ? (revision as string) : null;
}

/** The source revision is saved with its original's digest and size and is admitted for both hosts. */
async function originalRecorded(
  db: D1Database,
  revision: string,
): Promise<boolean> {
  const saved = await db
    .prepare(
      `SELECT s.details_json FROM source_nodes s JOIN admissions a
    ON a.source_revision_id = s.id WHERE s.id = ? AND s.kind = 'source_revision' AND a.both_hosts_eligible = 1`,
    )
    .bind(revision)
    .first<{details_json: string}>();
  try {
    const details =
      saved && (JSON.parse(saved.details_json) as Record<string, unknown>);
    return (
      !!details &&
      typeof details.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(details.sha256) &&
      typeof details.byte_count === 'number' &&
      details.byte_count > 0 &&
      details.locator === `originals/${revision}/${details.sha256}/original`
    );
  } catch {
    return false;
  }
}

/** An acquire-only recipe must have left its original and admission recorded for both hosts;
 *  other fetch recipes are checked by the build that reads their original. */
async function acquisitionRecorded(
  db: D1Database,
  scope: Scope,
  recipe: Recipe,
): Promise<boolean> {
  if (recipe.adapter?.name !== 'acquire-only') return true;
  const revision = acquireOnlyRevision(scope, recipe);
  return revision !== null && (await originalRecorded(db, revision));
}

/** Build step: run the recipe's units, then Control's own checks and, if the task lists it, the selection. */
async function buildStep(run: Run): Promise<Progress> {
  const {db, taskId, scope, objects} = run;
  const pinned = await pinnedRecipe(run, 'build');
  if ('done' in pinned) return pinned.done;
  const {recipe} = pinned;
  const ran = await runUnits(run, recipe, 'build');
  if ('done' in ran) return ran.done;
  let row = (await task(db, taskId))!;
  // A finished build waits, checked, for a later task that makes it current; it is not checked again.
  if (
    row.state === 'checked' &&
    !has(scope, 'select') &&
    (JSON.parse(row.outcome_json) as Outcome).candidate
  )
    return stop(row.state);
  await setOutcome(db, row, outcome => {
    outcome.completed_extent = scope.extent;
    outcome.remaining_extent = {};
  });
  row = (await task(db, taskId))!;
  if (
    !pinnedTo(recipe, 'build')(row) ||
    !['queued', 'running', 'checked'].includes(row.state)
  )
    return stop(row.state);
  // Quality passed for every unit: Control's own scope check, then the conditional selection.
  return resultOf(
    await checkAndSelect(
      db,
      objects,
      row,
      recipe,
      ran.succeeded,
      has(scope, 'select'),
    ),
  );
}

/** The task must ask for what the recipe makes: its extent exactly, and only its capabilities. */
function recipeFit(
  scope: Scope,
  recipe: Recipe,
  which: Which,
): string | undefined {
  const fetches = (recipe.units ?? []).every(unit => unit.kind === 'acquire');
  if (which === 'fetch' && !fetches)
    return 'the recipe has nothing to fetch; a fetch step names a fetch recipe';
  if (which === 'build' && fetches)
    return 'a fetch recipe cannot build; a build step names a build recipe';
  return which === 'fetch' ? fetchFit(scope, recipe) : buildFit(scope, recipe);
}

function fetchFit(scope: Scope, recipe: Recipe): string | undefined {
  if (
    recipe.adapter?.name === 'acquire-only' &&
    recipe.adapter.method_version === 'acquire-only/1'
  ) {
    const problem = acquireOnlyFit(scope, recipe);
    if (problem) return problem;
  }
  // Alone, the fetch describes what it keeps; before a build, the build's extent is the task's.
  if (
    !has(scope, 'build') &&
    canonicalJson(scope.extent) !== canonicalJson(recipe.native_extent ?? {})
  )
    return `the task extent must be the recipe's extent ${canonicalJson(recipe.native_extent)}`;
  return undefined;
}

function acquireOnlyFit(scope: Scope, recipe: Recipe): string | undefined {
  const revision = recipe.native_extent?.component;
  if (
    typeof revision !== 'string' ||
    !scope.inputs.some(
      ref => ref.kind === 'source_revision' && ref.id === revision,
    )
  )
    return `acquire requires source_revision ${String(revision)}`;
  if (
    !scope.inputs.some(
      ref => ref.kind === 'acquisition' && ref.id === recipe.manifest_revision,
    )
  )
    return `acquire requires acquisition ${String(recipe.manifest_revision)}`;
  if (
    scope.inputs.some(
      ref =>
        (ref.kind === 'source_revision' || ref.kind === 'acquisition') &&
        (ref.sha256 !== undefined || ref.byte_count !== undefined),
    )
  )
    return 'acquire inputs must omit sha256 and byte_count; the manifest pins the expected digest';
  return undefined;
}

function buildFit(scope: Scope, recipe: Recipe): string | undefined {
  if (scope.capabilities.length === 0)
    return 'capabilities: a build must request output capabilities';
  if (
    recipe.native_extent &&
    canonicalJson(scope.extent) !== canonicalJson(recipe.native_extent)
  )
    return `the task extent must be the recipe's extent ${canonicalJson(recipe.native_extent)}`;
  // The scope check compares outputs with these unit lists; other extent shapes are refused up front.
  for (const unit of recipe.units ?? [])
    if (!(
      Array.isArray(unit.native_extent.unit_ids) &&
      unit.native_extent.unit_ids.length
    ))
      return `recipe unit ${unit.unit_id} must list its native unit_ids`;
  const offered = new Set(recipe.capabilities ?? []);
  const extra = scope.capabilities.filter(
    capability => !offered.has(capability),
  );
  return extra.length
    ? `the recipe does not provide ${extra.join(', ')}`
    : undefined;
}

/** The job plan for one unit: exact dependency outputs, and the candidate for a quality unit. */
async function unitPlan(
  db: D1Database,
  recipe: Recipe,
  unit: RecipeUnit,
  succeeded: Map<string, JobResult>,
): Promise<UnitPlan | {problem: string}> {
  const refs = new Map<string, ArtifactRef>();
  for (const dependency of unit.depends_on)
    for (const ref of succeeded.get(dependency)!.output_refs)
      refs.set(ref.artifact_id, ref);
  if (refs.size > 64)
    return {
      problem: `unit ${unit.unit_id} depends on more than 64 outputs; the recipe must split it`,
    };
  const plan: UnitPlan = {
    unit_id: unit.unit_id,
    kind: unit.kind,
    manifest_revision: recipe.manifest_revision!,
    recipe_revision: recipe.revision,
    native_extent: unit.native_extent,
    dependency_refs: [...refs.values()],
    // A fetch makes no outputs, whatever the task's build asks for.
    ...(unit.kind === 'acquire'
      ? {required_capabilities: []}
      : unit.required_capabilities
        ? {required_capabilities: unit.required_capabilities}
        : {}),
  };
  if (unit.kind === 'quality') {
    // The candidate is every prepared output of this task's succeeded prepare units.
    const prepared = recipe
      .units!.filter(
        item => item.kind === 'prepare' && succeeded.has(item.unit_id),
      )
      .flatMap(item =>
        succeeded.get(item.unit_id)!.output_refs.map(ref => ref.artifact_id),
      );
    const ids = new Set<string>();
    for (let start = 0; start < prepared.length; start += 50) {
      const chunk = prepared.slice(start, start + 50);
      const rows = await db
        .prepare(
          `SELECT DISTINCT output_id FROM artifacts WHERE id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(...chunk)
        .all<{output_id: string}>();
      for (const row of rows.results) ids.add(row.output_id);
    }
    if (ids.size === 0)
      return {
        problem: `quality unit ${unit.unit_id} has no saved prepared outputs to check`,
      };
    plan.constraints = {
      candidate: {added: [...ids].sort(), reused: [], omitted: []},
    };
  }
  return plan;
}

/** Jobs whose dispatch was never confirmed by a run. A dispatch is lost only when the complete
 *  list of unfinished runs has none titled with its input basis; otherwise that run is still on
 *  its way and confirms itself through the state route. */
async function lostDispatches(
  db: D1Database,
  github: GitHubActions,
  taskId: string,
  jobs: JobView[],
): Promise<string[]> {
  const notes: string[] = [];
  let active: Array<{run_id: string; title: string}> | null = null;
  try {
    active = await github.activeRuns();
    if (active === null)
      notes.push(
        'The list of unfinished runs was incomplete; unconfirmed dispatches are checked again later',
      );
  } catch (error) {
    reportError(error, {
      tool: 'control',
      stage: 'active_runs',
      code: 'github_unavailable',
      outcome: 'uncertain',
      ids: {task: taskId},
    });
    notes.push(
      'GitHub was unavailable; unconfirmed dispatches are checked again later',
    );
  }
  if (!active) return notes;
  const unconfirmed = jobs.filter(
    item =>
      item.run_id === null &&
      !active.some(run => run.title === runTitle(item.input_basis!)),
  );
  for (const job of unconfirmed) {
    const changed = await db
      .prepare(
        `UPDATE maintenance_jobs SET state = 'cancelled'
    WHERE task_id = ? AND unit_id = ? AND attempt = ? AND state = 'intended' AND run_id IS NULL`,
      )
      .bind(taskId, job.unit_id, job.attempt)
      .run();
    if (changed.meta.changes)
      notes.push(
        `unit ${job.unit_id} attempt ${job.attempt}: dispatch was not confirmed by any run`,
      );
  }
  return notes;
}

/** A run that ended without delivering a result fails its job; for a stopped task, runs still
 *  going are asked to cancel again. */
async function settleRun(
  db: D1Database,
  github: GitHubActions,
  taskId: string,
  job: JobView,
  stopped: boolean,
): Promise<string | null> {
  let status: string;
  try {
    status = (await github.run(job.run_id!)).status;
  } catch {
    return null;
  }
  if (status !== 'completed')
    return stopped
      ? `unit ${job.unit_id} attempt ${job.attempt}: ${(await github.cancel(job.run_id!)) ? 'cancellation requested again' : 'cancellation request failed; retried on the next check'}`
      : null;
  const changed = await db
    .prepare(
      `UPDATE maintenance_jobs SET state = ?
    WHERE task_id = ? AND unit_id = ? AND attempt = ? AND run_id = ? AND state IN ('dispatched','running')`,
    )
    .bind(
      stopped ? 'cancelled' : 'failed',
      taskId,
      job.unit_id,
      job.attempt,
      job.run_id,
    )
    .run();
  return changed.meta.changes
    ? `unit ${job.unit_id} attempt ${job.attempt}: run ended ${stopped ? 'after cancellation' : 'without a result'}`
    : null;
}

/** Bring recorded jobs in line with actual runs: a dispatch whose response was lost and that no
 *  unfinished run can still claim, and a run that ended without delivering a result. */
export async function reconcile(
  db: D1Database,
  github: GitHubActions | null,
  taskId: string,
): Promise<string[]> {
  if (!github) return [];
  const row = await task(db, taskId);
  if (!row) return [];
  // For a cancelled or superseded task, unfinished runs are cancelled again on every check
  // until GitHub reports them finished; the job rows keep this durable.
  const stopped = row.state === 'cancelled' || row.state === 'superseded';
  const jobs = (
    await db
      .prepare(
        `SELECT unit_id, attempt, kind, state, run_id, result_json, input_basis FROM maintenance_jobs
    WHERE task_id = ? AND state IN ('intended','dispatched','running')`,
      )
      .bind(taskId)
      .all<JobView>()
  ).results;
  const notes =
    !stopped && jobs.some(job => job.run_id === null)
      ? await lostDispatches(db, github, taskId, jobs)
      : [];
  for (const job of jobs.filter(item => item.run_id !== null)) {
    const note = await settleRun(db, github, taskId, job, stopped);
    if (note) notes.push(note);
  }
  return notes;
}
