import {canonicalJson, sha256, type D1Database} from './d1.ts';
import type {JobResult, Recipe} from './contracts.ts';
import {
  inChunks,
  members,
  releaseVersions,
  storedSizes,
  validateMembers,
  type ObjectStore,
  type Output,
  type Stored,
} from './release-check.ts';
import {membership} from './release-members.ts';
import {scopeCheck} from './release-scope.ts';
import {
  liftedBy,
  makeCurrent,
  recordedBy,
  releaseIdOf,
  type Plan,
  type SelectResult,
} from './release-write.ts';
import {restoreOrRollBack} from './release-direct.ts';
import {
  has,
  statementOf,
  type Outcome,
  type Scope,
  type TaskRow,
} from './tasks.ts';

/** Control's checks and the one guarded change of the selected release (Maintenance Control
 *  To-Be §4, MC-03).
 *
 *  Data Preparation's quality receipt says the candidate is sound. Control checks separately that
 *  the candidate is what the owner instructed and that the whole resulting release is complete,
 *  stored, admitted and not excluded, and only then selects it in one guarded D1 batch. A failed
 *  check or guard leaves the current release unchanged. Nothing here deletes data. */

export {
  FORMATS,
  READABLE_VERSIONS,
  SCHEMA_VERSIONS,
  selection,
  unreadable,
  validateMembers,
  validateRelease,
  type Check,
  type ObjectStore,
  type Output,
} from './release-check.ts';
export {membership} from './release-members.ts';
export {scopeCheck} from './release-scope.ts';
export {releaseCandidate} from './release-staged.ts';

const digestOf = async (value: unknown) =>
  `sha256:${await sha256(canonicalJson(value))}`;

interface Built {
  checked: Awaited<ReturnType<typeof scopeCheck>>;
  quality: string | null;
}

/** The ids of the statement outputs a new statement replaces in the base. */
async function replacedStatements(
  db: D1Database,
  scope: Scope,
  base: Output[],
) {
  if (!statementOf(scope)) return new Set<string>();
  return new Set(
    (
      await inChunks<{output_id: string}>(
        db,
        marks =>
          `SELECT output_id FROM character_statements WHERE output_id IN (${marks})`,
        base.map(item => item.id),
      )
    ).map(row => row.output_id),
  );
}

/** The whole release a checked candidate makes on the current release: base members kept, the
 *  candidate added, everything validated, with the report of what was found. */
async function wholeRelease(
  db: D1Database,
  stored: Stored,
  scope: Scope,
  checked: Built['checked'],
  currentId: string | null,
) {
  const replaces = new Set(
    Array.isArray(scope.constraints.replaces)
      ? (scope.constraints.replaces as string[])
      : [],
  );
  const base = await members(db, currentId);
  const replaced = await replacedStatements(db, scope, base);
  const whole = membership(
    base.filter(item => !replaced.has(item.id)),
    checked.candidate,
    replaces,
    new Set(),
  );
  const validation = await validateMembers(db, stored, whole.all, {
    added: new Set(checked.candidate.map(item => item.id)),
    approved: statementOf(scope),
    lifted: new Set(liftedBy(scope)),
  });
  const problems = [
    ...new Set([
      ...checked.problems,
      ...whole.problems,
      ...validation.problems,
    ]),
  ];
  const report = {
    ...checked.report,
    base_release_id: currentId,
    members: whole.ids.length,
    dropped: whole.dropped,
    notes: validation.notes,
    problems,
  };
  return {whole, validation, problems, report};
}

/** The release a checked candidate makes, on the given current release: the change to write, or
 *  the reasons it cannot be. */
async function buildPlan(
  db: D1Database,
  stored: Stored,
  task: TaskRow,
  recipe: Recipe,
  built: Built,
  select: boolean,
  currentId: string | null,
): Promise<Plan> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  const {checked, quality} = built;
  const {whole, validation, problems, report} = await wholeRelease(
    db,
    stored,
    scope,
    checked,
    currentId,
  );
  if (problems.length)
    return {outcome, problems, report, quality: built.quality};
  const scopeRef = await digestOf(report);
  const coverage = await digestOf(
    checked.coverage
      .map(row => [row.output_id, row.capability, row.state])
      .sort(),
  );
  const id = await releaseIdOf(whole.ids, quality!, scopeRef);
  const done: Outcome = {
    ...outcome,
    checks: {...outcome.checks, quality: 'passed', scope: 'passed'},
    scope_report: report,
  };
  return {
    outcome: select
      ? {...done, selection: {current_release_id: id, became_current: true}}
      : {
          ...done,
          candidate: {release_id: id, base_release_id: currentId},
          selection: {current_release_id: currentId, became_current: false},
        },
    change: {
      mode: select ? 'select' : 'stage',
      create: {
        id,
        members: whole.ids,
        formats: releaseVersions(whole.all),
        manifest: recipe.manifest_revision!,
        recipe: recipe.revision,
        quality: quality!,
        scope: scopeRef,
        coverage,
      },
      target: id,
      related: validation.related,
      lifted: liftedBy(scope),
      recorded: recordedBy(scope),
    },
  };
}

/** All units of a prepared task succeeded: check scope, build the release, validate it whole,
 *  and select it (or, for a build alone, record it as the checked candidate). */
export async function checkAndSelect(
  db: D1Database,
  objects: ObjectStore | null,
  task: TaskRow,
  recipe: Recipe,
  succeeded: Map<string, JobResult>,
  select = true,
): Promise<SelectResult> {
  const stored = await storedSizes(objects);
  const checked = await scopeCheck(db, stored, task, recipe, succeeded);
  const quality =
    checked.receipt &&
    !checked.problems.some(text => text.includes('quality receipt'))
      ? `${checked.receipt.artifact_id}@${checked.receipt.sha256}`
      : null;
  return makeCurrent(db, task, current =>
    buildPlan(
      db,
      stored,
      task,
      recipe,
      {checked, quality},
      select,
      current.current_release_id,
    ),
  );
}

/** Remove, rollback and restore validation: no preparation, the same checks and gate. */
export async function selectDirect(
  db: D1Database,
  objects: ObjectStore | null,
  task: TaskRow,
): Promise<SelectResult> {
  const scope = JSON.parse(task.scope_json) as Scope;
  const stored = await storedSizes(objects);
  if (has(scope, 'remove'))
    return makeCurrent(db, task, current =>
      removePlan(db, stored, task, scope, current.current_release_id),
    );
  return restoreOrRollBack(db, stored, task, scope);
}

/** The release a removal makes: the current one without the named sources, with the same
 *  manifest, recipe and coverage basis. */
async function removalRelease(
  db: D1Database,
  built: ReturnType<typeof membership>,
  currentId: string | null,
  digest: string,
) {
  const prior = (await db
    .prepare(
      'SELECT manifest_revision, recipe_revision, coverage_basis FROM releases WHERE id = ?',
    )
    .bind(currentId)
    .first<{
      manifest_revision: string;
      recipe_revision: string;
      coverage_basis: string;
    }>())!;
  const quality = `control-removal:${digest}`;
  return {
    id: await releaseIdOf(built.ids, quality, digest),
    members: built.ids,
    formats: releaseVersions(built.all),
    manifest: prior.manifest_revision,
    recipe: prior.recipe_revision,
    quality,
    scope: digest,
    coverage: prior.coverage_basis,
  };
}

/** Drop the named sources from the current release and record the owner's exclusions with it. */
async function removePlan(
  db: D1Database,
  stored: Stored,
  task: TaskRow,
  scope: Scope,
  currentId: string | null,
): Promise<Plan> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const removes = new Set(
    scope.inputs
      .filter(ref => ref.kind === 'source_revision')
      .map(ref => ref.id),
  );
  const recorded = recordedBy(scope);
  const built = membership(
    await members(db, currentId),
    [],
    new Set(),
    removes,
  );
  // What stays selected must not fall under the exclusions this removal records (a subject
  // may be an ancestor or component of another revision).
  const whole = await validateMembers(db, stored, built.all, {
    adding: new Set(recorded.map(ref => ref.subject!)),
  });
  const problems = [...built.problems, ...whole.problems];
  if (problems.length) return {outcome, problems};
  const change = {related: whole.related, lifted: [], recorded};
  // The owner's exclusions are recorded even when the current release holds none of the sources,
  // so a later rollback or task cannot bring them back.
  if (!built.dropped.length)
    return {
      outcome: {
        ...outcome,
        limitations: [
          ...outcome.limitations,
          currentId
            ? 'The current release holds none of the named sources.'
            : 'Nothing is current, so nothing was removed.',
        ],
        selection: {current_release_id: currentId, became_current: false},
      },
      change: {mode: 'none', ...change},
    };
  const report = {
    task_id: task.id,
    task_revision: task.revision,
    removed: built.dropped,
    members: built.ids.length,
    base_release_id: currentId,
  };
  const create = await removalRelease(
    db,
    built,
    currentId,
    await digestOf(report),
  );
  return {
    outcome: {
      ...outcome,
      checks: {...outcome.checks, scope: 'passed'},
      removal_report: report,
      selection: {current_release_id: create.id, became_current: true},
    },
    change: {mode: 'select', create, target: create.id, ...change},
  };
}
