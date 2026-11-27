import {canonicalJson, sha256, type D1Database} from './d1.ts';
import {
  inChunks,
  members,
  outputs,
  releaseVersions,
  storedSizes,
  validateMembers,
  type ObjectStore,
  type Output,
  type Stored,
} from './release-check.ts';
import {membership, overlaps} from './release-members.ts';
import {replacementProblems} from './release-replace.ts';
import {
  liftedBy,
  makeCurrent,
  recordedBy,
  releaseIdOf,
  replacedBy,
  type Plan,
  type SelectResult,
} from './release-write.ts';
import {has, type Outcome, type Scope, type TaskRow} from './tasks.ts';

/** A release task makes a finished build's checked candidate current (Maintenance Control To-Be
 *  §4). The build's saved outputs are reused: what the build added or removed against its own base
 *  is applied to whatever is current now, and the resulting release is checked again whole. */

interface Staging {
  build: TaskRow;
  built: Outcome;
  buildScope: Scope;
  candidate: {release_id: string; base_release_id: string | null};
}

const isCheckedBuild = (build: TaskRow, built: Outcome, scope: Scope) =>
  has(scope, 'build') &&
  !has(scope, 'select') &&
  build.state === 'checked' &&
  !!built.candidate &&
  built.checks?.quality === 'passed' &&
  built.checks.scope === 'passed';

/** The build this task releases, or why it cannot be released. */
async function stagedBuild(
  db: D1Database,
  task: TaskRow,
  scope: Scope,
  currentId: string | null,
): Promise<Staging | string> {
  const build = await db
    .prepare('SELECT * FROM maintenance_tasks WHERE id = ? AND requester = ?')
    .bind(scope.constraints.candidate, task.requester)
    .first<TaskRow>();
  if (!build)
    return `Candidate task ${String(scope.constraints.candidate)} was not found.`;
  const built = JSON.parse(build.outcome_json) as Outcome;
  const buildScope = JSON.parse(build.scope_json) as Scope;
  if (
    (build.state === 'completed' && built.selection?.became_current) ||
    currentId === built.candidate?.release_id
  )
    return 'This candidate is already current.';
  if (
    !isCheckedBuild(build, built, buildScope) ||
    !build.quality_ref ||
    !build.scope_ref
  )
    return 'The candidate must be a checked build that is not cancelled or superseded, with quality and scope checks passed.';
  return {build, built, buildScope, candidate: built.candidate!};
}

/** The build's changes applied to the current release. */
async function rebase(
  db: D1Database,
  staging: Staging,
  currentId: string | null,
) {
  const {buildScope, candidate: info} = staging;
  const original = await members(db, info.base_release_id);
  const candidate = await members(db, info.release_id);
  const current = await members(db, currentId);
  const originalIds = new Set(original.map(item => item.id));
  const candidateIds = new Set(candidate.map(item => item.id));
  const added = candidate.filter(item => !originalIds.has(item.id));
  const removed = original.filter(item => !candidateIds.has(item.id));
  const concurrent = current.filter(
    item => !originalIds.has(item.id) && !candidateIds.has(item.id),
  );
  const replaces = replacedBy(buildScope);
  if (
    concurrent.some(
      item =>
        replaces.has(item.revisions[0]) ||
        [...added, ...removed].some(change => overlaps(item, change)),
    )
  )
    return 'A newer release changed the same source extent; prepare this change again.';
  const removedIds = new Set(removed.map(item => item.id));
  const combined = membership(
    current.filter(item => !removedIds.has(item.id)),
    added,
    new Set(),
    new Set(),
  );
  if (combined.problems.length)
    return `The combined release cannot be selected: ${combined.problems[0]}`;
  return {candidate, added, current, combined};
}

type Rebased = Exclude<Awaited<ReturnType<typeof rebase>>, string>;

/** Check the combined release whole; the first problem refuses it. */
async function validateCombined(
  db: D1Database,
  stored: Stored,
  staging: Staging,
  rebased: Rebased,
) {
  const {candidate, added, current, combined} = rebased;
  const currentIds = new Set(current.map(item => item.id));
  const listed = (await db
    .prepare(
      'SELECT COUNT(*) AS total FROM release_outputs WHERE release_id = ?',
    )
    .bind(staging.candidate.release_id)
    .first<{total: number}>())!.total;
  const check = await validateMembers(db, stored, combined.all, {
    added: new Set(
      added.filter(item => !currentIds.has(item.id)).map(item => item.id),
    ),
    approved: null,
    lifted: new Set(liftedBy(staging.buildScope)),
  });
  if (listed !== candidate.length)
    check.problems.unshift(
      `${listed - candidate.length} listed output(s) are not saved`,
    );
  return check;
}

/** A prepared build is held to the same replacement rule when it is made current. */
async function lostByReplacing(
  db: D1Database,
  {built, buildScope}: Staging,
  {current, combined}: Rebased,
) {
  const replaces = replacedBy(buildScope);
  if (!replaces.size) return [];
  const own = (built.scope_report?.candidate ?? []) as string[];
  return replacementProblems(
    db,
    replaces,
    current,
    combined.all,
    await outputs(db, own),
  );
}

const sameMembers = (candidate: Output[], ids: string[]) =>
  candidate
    .map(item => item.id)
    .sort()
    .join('|') === ids.join('|');

/** The release to make current: the build's own when nothing else changed since, otherwise a
 *  combined release over the same saved outputs. */
async function releaseFor(
  db: D1Database,
  staging: Staging,
  rebased: Rebased,
  currentId: string | null,
) {
  const {build, candidate: info} = staging;
  const {candidate, combined} = rebased;
  if (sameMembers(candidate, combined.ids)) return {target: info.release_id};
  const source = await db
    .prepare(
      'SELECT manifest_revision, recipe_revision FROM releases WHERE id = ?',
    )
    .bind(info.release_id)
    .first<{manifest_revision: string; recipe_revision: string}>();
  if (!source) return 'The checked candidate metadata is missing.';
  const rows = await inChunks<{
    output_id: string;
    capability: string;
    state: string;
  }>(
    db,
    marks =>
      `SELECT output_id, capability, state FROM coverage WHERE output_id IN (${marks})`,
    combined.ids,
  );
  const digest = async (value: unknown) =>
    `sha256:${await sha256(canonicalJson(value))}`;
  const scope = await digest({
    build: build.id,
    candidate: info.release_id,
    base: currentId,
    members: combined.ids,
  });
  const id = await releaseIdOf(combined.ids, build.quality_ref!, scope);
  return {
    target: id,
    create: {
      id,
      members: combined.ids,
      formats: releaseVersions(combined.all),
      manifest: source.manifest_revision,
      recipe: source.recipe_revision,
      quality: build.quality_ref!,
      scope,
      coverage: await digest(
        rows.map(row => [row.output_id, row.capability, row.state]).sort(),
      ),
    },
  };
}

/** The change a release task makes on the given current release, or why it is refused. */
async function releasePlan(
  db: D1Database,
  stored: Stored,
  task: TaskRow,
  currentId: string | null,
): Promise<Plan> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const refuse = (problem: string): Plan => ({outcome, problems: [problem]});
  const staging = await stagedBuild(
    db,
    task,
    JSON.parse(task.scope_json) as Scope,
    currentId,
  );
  if (typeof staging === 'string') return refuse(staging);
  const rebased = await rebase(db, staging, currentId);
  if (typeof rebased === 'string') return refuse(rebased);
  const lost = await lostByReplacing(db, staging, rebased);
  if (lost.length) return {outcome, problems: lost};
  const check = await validateCombined(db, stored, staging, rebased);
  if (check.problems.length)
    return refuse(
      `The candidate release no longer validates: ${check.problems[0]}`,
    );
  const next = await releaseFor(db, staging, rebased, currentId);
  if (typeof next === 'string') return refuse(next);
  const {build, built, buildScope} = staging;
  return {
    outcome: {
      ...outcome,
      checks: built.checks,
      limitations: [...outcome.limitations, ...check.notes],
      selection: {current_release_id: next.target, became_current: true},
    },
    staged: {
      id: build.id,
      revision: build.revision,
      outcome: built,
    },
    change: {
      mode: 'select',
      ...next,
      related: check.related,
      lifted: liftedBy(buildScope),
      recorded: recordedBy(buildScope),
      refs: {quality: build.quality_ref!, scope: build.scope_ref!},
    },
  };
}

/** Make a checked build's candidate current on whatever is current now. */
export async function releaseCandidate(
  db: D1Database,
  objects: ObjectStore | null,
  task: TaskRow,
): Promise<SelectResult> {
  const stored = await storedSizes(objects);
  return makeCurrent(db, task, current =>
    releasePlan(db, stored, task, current.current_release_id),
  );
}
