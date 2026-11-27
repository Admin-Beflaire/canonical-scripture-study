import {
  canonicalJson,
  sha256,
  type D1Database,
  type D1Statement,
} from './d1.ts';
import {
  has,
  type DecisionRef,
  type Outcome,
  type Scope,
  type TaskRow,
} from './tasks.ts';
import {selection} from './release-check.ts';

/** The one way Control changes what is selected (Maintenance Control To-Be §4, MC-03).
 *
 *  Every change is a single D1 batch whose statements share one guard: the task is still open at
 *  the revision that was read, the selected release is still the one the change was built on, and
 *  no active exclusion matches any source the release holds (unless this task lifts it). When the
 *  guard fails nothing is written: not the release, not its members, not an exclusion change.
 *  The caller then builds the change again on the new current release, a few times at most. */

export type SelectResult = {state: string; limitation?: string};

const OPEN = `('queued','running','checked')`;
const OPEN_STATES = ['queued', 'running', 'checked'];
/** Builds on a current release that moved under us, before the task is blocked. */
const TRIES = 3;

/** A release row a task records, with its members. */
export interface NewRelease {
  id: string;
  members: string[];
  formats: Record<string, string>;
  manifest: string;
  recipe: string;
  quality: string;
  scope: string;
  coverage: string;
}
/** What a task changes. `select` makes `target` current and completes the task; `stage` records a
 *  release and leaves the task `checked`; `none` completes the task without a selection change. */
export interface Change {
  mode: 'select' | 'stage' | 'none';
  /** The release to record first (a no-op if it exists); omitted when selecting an existing one. */
  create?: NewRelease;
  target?: string;
  /** Ids an exclusion could match: every member source revision, its ancestors and components. */
  related: string[];
  /** Exclusions this task lifts, and decisions it records. */
  lifted: string[];
  recorded: DecisionRef[];
  /** Quality and scope references kept on the task; the release's own when omitted. */
  refs?: {quality: string; scope: string};
}
/** The result of building a change: the outcome to store, and either problems or a change. */
export interface Plan {
  outcome: Outcome;
  change?: Change;
  /** The checked build this change makes current, so the guard can require it still checked. */
  staged?: Staged;
  problems?: string[];
  report?: unknown;
  quality?: string | null;
}
/** A checked build that a release task makes current. */
export interface Staged {
  id: string;
  revision: number;
  outcome: Outcome;
}

/** Exclusions the owner lifts with this task: exclusion decisions on a task that adds data. */
export const liftedBy = (scope: Scope) =>
  has(scope, 'remove')
    ? []
    : scope.decision_refs
        .filter(ref => ref.kind === 'exclusion' && ref.subject)
        .map(ref => ref.subject!);
/** The source revisions a build drops as a whole. */
export const replacedBy = (scope: Scope) =>
  new Set(
    Array.isArray(scope.constraints.replaces)
      ? (scope.constraints.replaces as string[])
      : [],
  );
export const recordedBy = (scope: Scope) =>
  has(scope, 'remove')
    ? scope.decision_refs.filter(ref => ref.kind === 'exclusion' && ref.subject)
    : [];

interface Guard {
  sql: string;
  args: unknown[];
}
/** The guard of a change. Once the release rows are written (`written`), it also requires that the
 *  release exists with all its members. A task completes only under the whole guard, and the
 *  selection follows only if the task completed, so a task never reports a selection that another
 *  task made. */
function guardOf(
  task: TaskRow,
  base: string | null,
  change: Change,
  staged: Staged | null,
  written = false,
): Guard {
  const build = staged
    ? ` AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'checked')`
    : '';
  const stored =
    written && change.target
      ? ` AND EXISTS (SELECT 1 FROM releases WHERE id = ?)${
          change.create
            ? ` AND (SELECT COUNT(*) FROM release_outputs WHERE release_id = ?) = ?`
            : ''
        }`
      : '';
  return {
    sql: `EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state IN ${OPEN})
      AND (SELECT current_release_id FROM release_selection WHERE singleton_id = 1) IS ?
      AND NOT EXISTS (SELECT 1 FROM maintenance_exclusions WHERE active = 1
        AND source_or_component_id IN (SELECT value FROM json_each(?))
        AND source_or_component_id NOT IN (SELECT value FROM json_each(?)))${build}${stored}`,
    args: [
      task.id,
      task.revision,
      base,
      JSON.stringify(change.related),
      JSON.stringify(change.lifted),
      ...(staged ? [staged.id, staged.revision] : []),
      ...(written && change.target
        ? [
            change.target,
            ...(change.create
              ? [change.target, change.create.members.length]
              : []),
          ]
        : []),
    ],
  };
}

function recordRelease(
  db: D1Database,
  release: NewRelease,
  guard: Guard,
): D1Statement[] {
  return [
    db
      .prepare(
        `INSERT INTO releases(id, manifest_revision, recipe_revision, schema_versions_json, coverage_basis, quality_receipt, scope_receipt)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql} AND NOT EXISTS (SELECT 1 FROM releases WHERE id = ?)`,
      )
      .bind(
        release.id,
        release.manifest,
        release.recipe,
        canonicalJson(release.formats),
        release.coverage,
        release.quality,
        release.scope,
        ...guard.args,
        release.id,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO release_outputs(release_id, output_id) SELECT ?, value FROM json_each(?)
      WHERE ${guard.sql} AND EXISTS (SELECT 1 FROM releases WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM release_selection WHERE ? IN (current_release_id, previous_release_id))`,
      )
      .bind(
        release.id,
        JSON.stringify(release.members),
        ...guard.args,
        release.id,
        release.id,
      ),
  ];
}

/** The task's exclusion decisions, written before the task completes and under the same guard. */
function exclusionChanges(
  db: D1Database,
  task: TaskRow,
  change: Change,
  guard: Guard,
): D1Statement[] {
  return [
    ...change.recorded.map(ref =>
      db
        .prepare(
          `INSERT INTO maintenance_exclusions(source_or_component_id, decision_ref, task_id, revision, active)
      SELECT ?, ?, ?, ?, 1 WHERE ${guard.sql} ON CONFLICT(source_or_component_id, decision_ref) DO UPDATE SET active = 1, revision = excluded.revision`,
        )
        .bind(ref.subject, ref.ref, task.id, task.revision, ...guard.args),
    ),
    ...change.lifted.map(subject =>
      db
        .prepare(
          `UPDATE maintenance_exclusions SET active = 0, revision = ?
      WHERE source_or_component_id = ? AND active = 1 AND ${guard.sql}`,
        )
        .bind(task.revision, subject, ...guard.args),
    ),
  ];
}

/** The selection moves only after the task completed under the guard, and only if the selected
 *  release is still the base: the task's completion and the selection stand or fall together. */
function makeSelected(
  db: D1Database,
  task: TaskRow,
  base: string | null,
  change: Change,
): D1Statement {
  return db
    .prepare(
      `UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = ?
      WHERE singleton_id = 1 AND current_release_id IS ?
        AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'completed')`,
    )
    .bind(change.target, base, task.id, task.revision + 1);
}

/** The task row after the change: its state, release references and outcome. */
function updateTask(
  db: D1Database,
  task: TaskRow,
  base: string | null,
  change: Change,
  state: 'completed' | 'checked',
  outcome: Outcome,
  after: Guard,
): D1Statement {
  const refs = change.refs ?? change.create;
  return db
    .prepare(
      `UPDATE maintenance_tasks SET state = ?, revision = revision + 1, outcome_json = ?,
      base_release_id = COALESCE(?, base_release_id), candidate_release_id = COALESCE(?, candidate_release_id),
      quality_ref = COALESCE(?, quality_ref), scope_ref = COALESCE(?, scope_ref)
      WHERE id = ? AND revision = ? AND ${after.sql}`,
    )
    .bind(
      state,
      canonicalJson(outcome),
      change.target ? base : null,
      change.target ?? null,
      refs?.quality ?? null,
      refs?.scope ?? null,
      task.id,
      task.revision,
      ...after.args,
    );
}

function finishStaged(
  db: D1Database,
  staged: Staged,
  task: TaskRow,
  target: string,
): D1Statement {
  return db
    .prepare(
      `UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
      WHERE id = ? AND revision = ? AND state = 'checked'
        AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'completed')`,
    )
    .bind(
      canonicalJson({
        ...staged.outcome,
        selection: {current_release_id: target, became_current: true},
      }),
      staged.id,
      staged.revision,
      task.id,
      task.revision + 1,
    );
}

function statementsOf(
  db: D1Database,
  task: TaskRow,
  base: string | null,
  change: Change,
  staged: Staged | null,
  outcome: Outcome,
): D1Statement[] {
  const open = guardOf(task, base, change, staged);
  const written = guardOf(task, base, change, staged, true);
  const created = change.create ? recordRelease(db, change.create, open) : [];
  if (change.mode === 'stage')
    return [
      ...created,
      updateTask(db, task, base, change, 'checked', outcome, written),
    ];
  if (change.mode === 'none')
    return [
      ...exclusionChanges(db, task, change, open),
      updateTask(db, task, base, change, 'completed', outcome, open),
    ];
  // The task completes under the full guard first; the selection follows only if it did.
  return [
    ...created,
    ...exclusionChanges(db, task, change, written),
    updateTask(db, task, base, change, 'completed', outcome, written),
    makeSelected(db, task, base, change),
    ...(staged ? [finishStaged(db, staged, task, change.target!)] : []),
  ];
}

/** Write the change in one batch and read the task back. `null` means the guard failed and
 *  nothing was written; the caller builds the change again. */
async function write(
  db: D1Database,
  task: TaskRow,
  base: string | null,
  change: Change,
  staged: Staged | null,
  outcome: Outcome,
): Promise<SelectResult | null> {
  const expected = change.mode === 'stage' ? 'checked' : 'completed';
  let lost = false;
  try {
    await db.batch(statementsOf(db, task, base, change, staged, outcome));
  } catch {
    lost = true; // A lost response: the read below decides.
  }
  const now = await db
    .prepare('SELECT state, revision FROM maintenance_tasks WHERE id = ?')
    .bind(task.id)
    .first<{state: string; revision: number}>();
  if (now?.state === expected && now.revision === task.revision + 1)
    return {state: expected};
  const unchanged =
    !!now && now.revision === task.revision && OPEN_STATES.includes(now.state);
  if (unchanged && !lost) return null;
  return {
    state: now?.state ?? 'unknown',
    limitation: lost
      ? 'The change was interrupted; the next check tries again.'
      : 'The task changed during the check.',
  };
}

/** Make a release current, or finish, or stage it: build the change on the current release, write
 *  it under the guard, and if the guard failed because the selection moved, build it again. */
export async function makeCurrent(
  db: D1Database,
  task: TaskRow,
  plan: (current: {
    current_release_id: string | null;
    previous_release_id: string | null;
  }) => Promise<Plan>,
): Promise<SelectResult> {
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const current = await selection(db);
    const planned = await plan(current);
    if (!planned.change)
      return block(
        db,
        task,
        planned.outcome,
        planned.problems ?? [],
        planned.report,
        planned.quality,
      );
    const written = await write(
      db,
      task,
      current.current_release_id,
      planned.change,
      planned.staged ?? null,
      planned.outcome,
    );
    if (written) return written;
  }
  return block(db, task, JSON.parse(task.outcome_json) as Outcome, [
    'The current release or the exclusions kept changing; request this again.',
  ]);
}

/** Block with the reasons. A quality check that passed is recorded as passed, with its receipt,
 *  even when the scope check fails. */
export async function block(
  db: D1Database,
  task: TaskRow,
  outcome: Outcome,
  problems: string[],
  report?: unknown,
  quality?: string | null,
): Promise<SelectResult> {
  const next: Outcome = {
    ...outcome,
    limitations: [
      ...new Set([...outcome.limitations, ...problems.slice(0, 20)]),
    ],
    checks: {
      ...outcome.checks,
      ...(quality ? {quality: 'passed' as const} : {}),
      scope: 'failed',
    },
    ...(report ? {scope_report: report as Outcome['scope_report']} : {}),
  };
  await db
    .prepare(
      `UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1, outcome_json = ?,
      quality_ref = COALESCE(?, quality_ref) WHERE id = ? AND revision = ? AND state IN ${OPEN}`,
    )
    .bind(canonicalJson(next), quality ?? null, task.id, task.revision)
    .run();
  return {state: 'blocked', limitation: problems[0]};
}

/** The release row's identity: the same members, quality check and scope check give the same id. */
export async function releaseIdOf(
  members: string[],
  quality: string,
  scope: string,
) {
  const digest = await sha256(canonicalJson({members, quality, scope}));
  return `release-${digest.slice(0, 32)}`;
}
