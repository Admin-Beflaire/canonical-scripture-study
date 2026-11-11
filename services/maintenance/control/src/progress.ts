import { canonicalJson, type D1Database } from './d1.ts';
import { recipeErrors, type ArtifactRef, type JobResult, type Recipe, type RecipeUnit } from './contracts.ts';
import { dispatchUnit, type DispatchResult, type UnitPlan } from './dispatch.ts';
import { FileEncodingError, GitHubError, runTitle, type GitHubActions } from './github.ts';
import { checkAndSelect, selectDirect, type ObjectStore } from './selection.ts';
import type { Outcome, Scope, TaskRow } from './tasks.ts';

/** Task progression without an open chat (Maintenance Control To-Be §2–3, MC-02).
 *  The recipe's units are Data Preparation's partition; Control only reads them, dispatches
 *  ready units and reconciles interrupted ones. When every unit has succeeded, the scope check
 *  and conditional selection follow (selection.ts, MC-03). */
export const MAX_ATTEMPTS = 3;
const ACTIVE = new Set(['intended', 'dispatched', 'running', 'checkpointed']);
const RETRYABLE = new Set(['failed', 'cancelled']);

interface JobView { unit_id: string; attempt: number; kind: string; state: string; run_id: string | null; result_json: string | null; input_basis?: string }
export type Progress = { dispatched: string[]; state: string; limitation?: string };

/** Read and check the recipe named in the task, from reviewed main. */
export async function loadRecipe(github: GitHubActions, id: unknown): Promise<{ recipe?: Recipe; problem?: string }> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(id)) return { problem: 'constraints.recipe must name a reviewed recipe' };
  let text: string | null;
  try { text = await github.readFile(`collection/recipes/${id}.json`); }
  catch (error) {
    if (error instanceof FileEncodingError) return { problem: `recipe ${id} is not valid UTF-8` };
    throw error;
  }
  if (text === null) return { problem: `recipe ${id} is not on main` };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { problem: `recipe ${id} is not valid JSON` }; }
  const errors = recipeErrors(value);
  if (errors.length) return { problem: `recipe ${id} is invalid: ${errors.slice(0, 3).join('; ')}` };
  const recipe = value as Recipe;
  if (!recipe.units || !recipe.manifest_revision) return { problem: `recipe ${id} has no units or manifest revision to dispatch` };
  const seen = new Set<string>();
  for (const unit of recipe.units) {
    // Units are listed in dependency order, which also rules out cycles.
    if (seen.has(unit.unit_id) || !unit.depends_on.every(dependency => seen.has(dependency)))
      return { problem: `recipe ${id} unit ${unit.unit_id} is duplicated or depends on a later unit` };
    seen.add(unit.unit_id);
  }
  return { recipe };
}

async function task(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').bind(id).first<TaskRow>();
}

/** Every task change advances its revision (a database rule), so unchanged outcomes are not
 *  rewritten. Notes are written only when no unit is running, except a block, which stops work. */
async function setOutcome(db: D1Database, row: TaskRow, change: (outcome: Outcome & { recipe_revision?: string }) => void, state?: 'blocked') {
  const outcome = JSON.parse(row.outcome_json) as Outcome & { recipe_revision?: string };
  change(outcome);
  const text = canonicalJson(outcome);
  if (!state && text === canonicalJson(JSON.parse(row.outcome_json))) return;
  const sql = state
    ? `UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1, outcome_json = ? WHERE id = ? AND revision = ? AND state IN ('queued','running')`
    : `UPDATE maintenance_tasks SET revision = revision + 1, outcome_json = ? WHERE id = ? AND revision = ?`;
  await db.prepare(sql).bind(text, row.id, row.revision).run();
}

function addLimitation(outcome: Outcome, text: string) {
  if (!outcome.limitations.includes(text)) outcome.limitations.push(text);
}

/** Dispatch every unit whose dependencies have succeeded. Safe to call repeatedly. */
export async function advance(db: D1Database, github: GitHubActions | null, taskId: string, objects: ObjectStore | null = null): Promise<Progress> {
  let row = await task(db, taskId);
  if (!row) return { dispatched: [], state: 'unknown' };
  if (!['queued', 'running', 'checked'].includes(row.state)) return { dispatched: [], state: row.state };
  const scope = JSON.parse(row.scope_json) as Scope;
  if (scope.constraints.recipe === undefined) {
    // Removal, rollback and restore validation prepare nothing: they go straight to the checks and gate.
    if (DIRECT.has(scope.kind) && row.state !== 'checked') {
      const selected = await selectDirect(db, objects, row);
      return { dispatched: [], state: selected.state, ...(selected.limitation ? { limitation: selected.limitation } : {}) };
    }
    return { dispatched: [], state: row.state }; // Not a dispatched task kind.
  }
  if (!github) {
    await setOutcome(db, row, outcome => addLimitation(outcome, 'Preparation dispatch is not configured for Control.'));
    return { dispatched: [], state: row.state, limitation: 'dispatch_not_configured' };
  }
  let loaded: Awaited<ReturnType<typeof loadRecipe>>;
  try { loaded = await loadRecipe(github, scope.constraints.recipe); }
  catch (error) {
    // A temporary GitHub failure postpones progression; it never blocks the task.
    if (error instanceof GitHubError) return { dispatched: [], state: row.state, limitation: 'github_unavailable' };
    throw error;
  }
  const { recipe, problem: invalid } = loaded;
  const pinned = (JSON.parse(row.outcome_json) as { recipe_revision?: string }).recipe_revision;
  const changed = recipe && pinned && pinned !== recipe.revision
    ? `recipe changed from ${pinned} to ${recipe.revision}; start a new task for the changed recipe` : undefined;
  const problem = invalid ?? (recipe ? recipeFit(scope, recipe) : undefined);
  if (problem || changed) {
    await setOutcome(db, row, outcome => addLimitation(outcome, (problem ?? changed)!), 'blocked');
    return { dispatched: [], state: 'blocked', limitation: problem ?? changed };
  }
  if (!pinned) await setOutcome(db, row, outcome => { outcome.recipe_revision = recipe!.revision; });
  // Dispatch only under the pin that is actually saved: a concurrent first advance may have
  // pinned a different recipe revision. The pin is checked again before every dispatch.
  const pinnedNow = (current: TaskRow) => (JSON.parse(current.outcome_json) as { recipe_revision?: string }).recipe_revision === recipe!.revision;
  row = (await task(db, taskId))!;
  if (!pinnedNow(row)) return { dispatched: [], state: row.state };

  const jobs = (await db.prepare('SELECT unit_id, attempt, kind, state, run_id, result_json FROM maintenance_jobs WHERE task_id = ? ORDER BY unit_id, attempt')
    .bind(taskId).all<JobView>()).results;
  const byUnit = new Map<string, JobView[]>();
  for (const job of jobs) byUnit.set(job.unit_id, [...(byUnit.get(job.unit_id) ?? []), job]);
  const succeeded = new Map<string, JobResult>();
  for (const [unit, attempts] of byUnit) {
    const done = attempts.find(job => job.state === 'succeeded' && job.result_json);
    if (done) succeeded.set(unit, JSON.parse(done.result_json!) as JobResult);
  }

  const dispatched: string[] = [];
  for (const unit of recipe!.units!) {
    const attempts = byUnit.get(unit.unit_id) ?? [];
    const latest = attempts[attempts.length - 1];
    if (succeeded.has(unit.unit_id) || (latest && ACTIVE.has(latest.state))) continue;
    if (latest && RETRYABLE.has(latest.state) && attempts.length >= MAX_ATTEMPTS) {
      const codes = latest.result_json ? (JSON.parse(latest.result_json) as JobResult).diagnostics.map(d => d.code).join(', ') : 'no result';
      const text = `unit ${unit.unit_id} did not succeed in ${MAX_ATTEMPTS} attempts (${codes || 'no diagnostics'})`;
      row = (await task(db, taskId))!;
      await setOutcome(db, row, outcome => addLimitation(outcome, text), 'blocked');
      return { dispatched, state: 'blocked', limitation: text };
    }
    if (!unit.depends_on.every(dependency => succeeded.has(dependency))) continue;
    const plan = await unitPlan(db, recipe!, unit, succeeded);
    if ('problem' in plan) {
      row = (await task(db, taskId))!;
      await setOutcome(db, row, outcome => addLimitation(outcome, plan.problem), 'blocked');
      return { dispatched, state: 'blocked', limitation: plan.problem };
    }
    row = (await task(db, taskId))!;
    if (!['queued', 'running'].includes(row.state) || !pinnedNow(row)) break;
    const result: DispatchResult = await dispatchUnit(db, github, taskId, row.revision, plan);
    if (result.status === 'dispatched') dispatched.push(unit.unit_id);
    // The task stopped while the run was starting: it has no job record, so stop it now. If that
    // fails, the runner still refuses at its first Control check because no dispatch is recorded.
    if (result.status === 'orphaned') await github.cancel(result.run_id);
    if (result.status === 'uncertain' || result.status === 'not_dispatchable' || result.status === 'orphaned') break;
  }

  row = (await task(db, taskId))!;
  if (recipe!.units!.every(unit => succeeded.has(unit.unit_id)) && ['queued', 'running', 'checked'].includes(row.state)) {
    await setOutcome(db, row, outcome => {
      outcome.completed_extent = scope.extent;
      outcome.remaining_extent = {};
    });
    row = (await task(db, taskId))!;
    if (!pinnedNow(row) || !['queued', 'running', 'checked'].includes(row.state)) return { dispatched, state: row.state };
    // Quality passed for every unit: Control's own scope check, then the conditional selection.
    const selected = await checkAndSelect(db, objects, row, recipe!, succeeded);
    return { dispatched, state: selected.state, ...(selected.limitation ? { limitation: selected.limitation } : {}) };
  }
  return { dispatched, state: row.state };
}

const DIRECT = new Set(['remove', 'rollback', 'validate_restore']);

/** The task must ask for what the recipe makes: its extent exactly, and only its capabilities. */
function recipeFit(scope: Scope, recipe: Recipe): string | undefined {
  if (recipe.native_extent && canonicalJson(scope.extent) !== canonicalJson(recipe.native_extent))
    return `the task extent must be the recipe's extent ${canonicalJson(recipe.native_extent)}`;
  const offered = new Set(recipe.capabilities ?? []);
  const extra = scope.capabilities.filter(capability => !offered.has(capability));
  if (extra.length) return `the recipe does not provide ${extra.join(', ')}`;
  return undefined;
}

/** The job plan for one unit: exact dependency outputs, and the candidate for a quality unit. */
async function unitPlan(db: D1Database, recipe: Recipe, unit: RecipeUnit, succeeded: Map<string, JobResult>): Promise<UnitPlan | { problem: string }> {
  const refs = new Map<string, ArtifactRef>();
  for (const dependency of unit.depends_on)
    for (const ref of succeeded.get(dependency)!.output_refs) refs.set(ref.artifact_id, ref);
  if (refs.size > 64) return { problem: `unit ${unit.unit_id} depends on more than 64 outputs; the recipe must split it` };
  const plan: UnitPlan = {
    unit_id: unit.unit_id, kind: unit.kind, manifest_revision: recipe.manifest_revision!, recipe_revision: recipe.revision,
    native_extent: unit.native_extent, dependency_refs: [...refs.values()], checkpoint_ref: null,
    ...(unit.required_capabilities ? { required_capabilities: unit.required_capabilities } : {}),
  };
  if (unit.kind === 'quality') {
    // The candidate is every prepared output of this task's succeeded prepare units.
    const prepared = recipe.units!.filter(item => item.kind === 'prepare' && succeeded.has(item.unit_id))
      .flatMap(item => succeeded.get(item.unit_id)!.output_refs.map(ref => ref.artifact_id));
    const ids = new Set<string>();
    for (let start = 0; start < prepared.length; start += 50) {
      const chunk = prepared.slice(start, start + 50);
      const rows = await db.prepare(`SELECT DISTINCT output_id FROM artifacts WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .bind(...chunk).all<{ output_id: string }>();
      for (const row of rows.results) ids.add(row.output_id);
    }
    if (ids.size === 0) return { problem: `quality unit ${unit.unit_id} has no saved prepared outputs to check` };
    plan.constraints = { candidate: { added: [...ids].sort(), reused: [], omitted: [] } };
  }
  return plan;
}

/** Bring recorded jobs in line with actual runs: a dispatch whose response was lost and that no
 *  unfinished run can still claim, and a run that ended without delivering a result. */
export async function reconcile(db: D1Database, github: GitHubActions | null, taskId: string): Promise<string[]> {
  if (!github) return [];
  const notes: string[] = [];
  const row = await task(db, taskId);
  if (!row) return notes;
  // For a cancelled or superseded task, unfinished runs are cancelled again on every check
  // until GitHub reports them finished; the job rows keep this durable.
  const stopped = row.state === 'cancelled' || row.state === 'superseded';
  const jobs = (await db.prepare(`SELECT unit_id, attempt, kind, state, run_id, result_json, input_basis FROM maintenance_jobs
    WHERE task_id = ? AND state IN ('intended','dispatched','running','checkpointed')`).bind(taskId).all<JobView>()).results;
  if (jobs.length === 0) return notes;
  if (!stopped && jobs.some(job => job.run_id === null)) {
    let active: Array<{ run_id: string; title: string }> | null = null;
    try {
      active = await github.activeRuns();
      if (active === null) notes.push('The list of unfinished runs was incomplete; unconfirmed dispatches are checked again later');
    } catch { notes.push('GitHub was unavailable; unconfirmed dispatches are checked again later'); }
    if (active) {
    // A dispatch is lost only when the complete list of unfinished runs has none titled with its
    // input basis. Otherwise that run is still on its way and confirms itself through the state route.
    {
      for (const job of jobs.filter(item => item.run_id === null && !active!.some(run => run.title === runTitle(item.input_basis!)))) {
        const changed = await db.prepare(`UPDATE maintenance_jobs SET state = 'cancelled'
          WHERE task_id = ? AND unit_id = ? AND attempt = ? AND state = 'intended' AND run_id IS NULL`)
          .bind(taskId, job.unit_id, job.attempt).run();
        if (changed.meta.changes) notes.push(`unit ${job.unit_id} attempt ${job.attempt}: dispatch was not confirmed by any run`);
      }
    }
    }
  }
  for (const job of jobs.filter(item => item.run_id !== null)) {
    let status: string;
    try { status = (await github.run(job.run_id!)).status; } catch { continue; }
    if (status !== 'completed') {
      if (stopped) notes.push(`unit ${job.unit_id} attempt ${job.attempt}: ${await github.cancel(job.run_id!) ? 'cancellation requested again' : 'cancellation request failed; retried on the next check'}`);
      continue;
    }
    const changed = await db.prepare(`UPDATE maintenance_jobs SET state = ?
      WHERE task_id = ? AND unit_id = ? AND attempt = ? AND run_id = ? AND state IN ('dispatched','running','checkpointed')`)
      .bind(stopped ? 'cancelled' : 'failed', taskId, job.unit_id, job.attempt, job.run_id).run();
    if (changed.meta.changes) notes.push(`unit ${job.unit_id} attempt ${job.attempt}: run ended ${stopped ? 'after cancellation' : 'without a result'}`);
  }
  return notes;
}
