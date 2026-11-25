import type {D1Database} from './d1.ts';
import {
  validateRelease,
  type Check,
  type Stored,
  type Validation,
} from './release-check.ts';
import {makeCurrent, type Plan, type SelectResult} from './release-write.ts';
import {has, type Outcome, type Scope, type TaskRow} from './tasks.ts';

/** Rollback and restore validation (Maintenance Control To-Be §4): no preparation, the same
 *  whole-release check and the same guarded change as every other selection. */

type Current = {
  current_release_id: string | null;
  previous_release_id: string | null;
};

/** Finish without a selection change; the limitation says why. */
const finish = (
  outcome: Outcome,
  currentId: string | null,
  limitation: string,
  extra: Partial<Outcome> = {},
): Plan => ({
  outcome: {
    ...outcome,
    ...extra,
    limitations: [...(extra.limitations ?? outcome.limitations), limitation],
    selection: {current_release_id: currentId, became_current: false},
  },
  change: {mode: 'none', related: [], lifted: [], recorded: []},
});

/** Select an existing, validated release; the previously current one becomes previous. */
const selectExisting = (
  outcome: Outcome,
  check: Validation,
  target: string,
): Plan => ({
  outcome: {
    ...outcome,
    limitations: [...outcome.limitations, ...check.notes],
    selection: {current_release_id: target, became_current: true},
  },
  change: {
    mode: 'select',
    target,
    related: check.related,
    lifted: [],
    recorded: [],
  },
});

async function rollbackPlan(
  db: D1Database,
  stored: Stored,
  outcome: Outcome,
  current: Current,
): Promise<Plan> {
  const previous = current.previous_release_id;
  if (!previous)
    return finish(
      outcome,
      current.current_release_id,
      'No previous release is available; the current release is unchanged.',
    );
  const check = await validateRelease(db, stored, previous);
  if (check.problems.length)
    return finish(
      outcome,
      current.current_release_id,
      'The previous release is not eligible; the current release is unchanged.',
      {limitations: [...outcome.limitations, ...check.problems.slice(0, 20)]},
    );
  return selectExisting(outcome, check, previous);
}

/** Block every restored open task, in one statement: nothing restarts by itself. */
async function blockRestored(db: D1Database, taskId: string) {
  const note = `Blocked by restore validation in ${taskId}; check the restored state, then resume.`;
  const blocked = await db
    .prepare(
      `UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1,
      outcome_json = json_set(outcome_json, '$.limitations', json_insert(json_extract(outcome_json, '$.limitations'), '$[#]', ?))
    WHERE id <> ? AND state IN ('queued','running','checked') RETURNING id`,
    )
    .bind(note, taskId)
    .all<{id: string}>();
  return blocked.results.map(row => row.id);
}

/** Check the restored releases; select the one the task names, only when it passes. */
async function restorePlan(
  db: D1Database,
  stored: Stored,
  outcome: Outcome,
  scope: Scope,
  blocked: string[],
  current: Current,
): Promise<Plan> {
  const results: Record<string, Check> = {};
  for (const id of [current.current_release_id, current.previous_release_id])
    if (id) results[id] = await validateRelease(db, stored, id);
  const report = {releases: results, blocked_tasks: blocked};
  const wanted =
    typeof scope.constraints.select_release === 'string'
      ? scope.constraints.select_release
      : null;
  if (wanted && wanted !== current.current_release_id) {
    const check = await validateRelease(db, stored, wanted);
    return check.problems.length
      ? finish(
          outcome,
          current.current_release_id,
          `Release ${wanted} is not eligible; the current release is unchanged.`,
          {
            restore_report: report,
            limitations: [
              ...outcome.limitations,
              ...check.problems.slice(0, 20),
            ],
          },
        )
      : selectExisting({...outcome, restore_report: report}, check, wanted);
  }
  const problems = Object.entries(results).flatMap(([id, check]) =>
    check.problems.map(problem => `${id}: ${problem}`),
  );
  return finish(
    outcome,
    current.current_release_id,
    problems.length
      ? 'The restored state did not pass validation; see the limitations.'
      : 'The restored releases passed validation.',
    {
      restore_report: report,
      limitations: [...outcome.limitations, ...problems.slice(0, 20)],
    },
  );
}

/** Rollback, or restore validation (which blocks restored open work first). */
export async function restoreOrRollBack(
  db: D1Database,
  stored: Stored,
  task: TaskRow,
  scope: Scope,
): Promise<SelectResult> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  if (has(scope, 'rollback'))
    return makeCurrent(db, task, current =>
      rollbackPlan(db, stored, outcome, current),
    );
  const blocked = await blockRestored(db, task.id);
  return makeCurrent(db, task, current =>
    restorePlan(db, stored, outcome, scope, blocked, current),
  );
}
