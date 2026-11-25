import type {ArtifactRef, JobResult, Recipe} from './contracts.ts';
import type {D1Database} from './d1.ts';
import {
  inChunks,
  outputs,
  storageProblem,
  type ArtifactRow,
  type Output,
  type Stored,
} from './release-check.ts';
import {units} from './release-members.ts';
import type {Scope, TaskRow} from './tasks.ts';

/** Scope check of a prepared candidate (Maintenance Control To-Be §4, MC-03): exactly the
 *  outputs the task's units saved and its quality unit checked, inside what the owner instructed. */

/** Resolve result references exactly: each must be a saved artifact with the stated digest and size. */
async function resolve(db: D1Database, refs: ArtifactRef[], what: string) {
  const problems: string[] = [];
  const rows = new Map(
    (
      await inChunks<ArtifactRow>(
        db,
        marks => `SELECT id, output_id, sha256, byte_count, format, registered_locator
    FROM artifacts WHERE id IN (${marks})`,
        refs.map(ref => ref.artifact_id),
      )
    ).map(row => [row.id, row]),
  );
  const ids = new Set<string>();
  for (const ref of refs) {
    const row = rows.get(ref.artifact_id);
    if (!row)
      problems.push(
        `${what} reference ${ref.artifact_id} is not a saved artifact`,
      );
    else if (row.sha256 !== ref.sha256 || row.byte_count !== ref.byte_count)
      problems.push(
        `${what} reference ${ref.artifact_id} does not match the saved artifact`,
      );
    else if (!row.output_id)
      problems.push(
        `${what} reference ${ref.artifact_id} belongs to no prepared output`,
      );
    else ids.add(row.output_id);
  }
  return {problems, ids};
}

/** The quality receipt must exist, be well formed and be stored as referenced. */
function receiptProblems(stored: Stored, receipt: ArtifactRef | null) {
  if (!receipt) return ['no quality receipt'];
  if (receipt.artifact_id !== `receipt:${receipt.sha256.slice(0, 32)}`)
    return ['the quality receipt reference is malformed'];
  const size = storageProblem(stored)
    ? receipt.byte_count
    : (stored as Map<string, number>).get(
        `prepared/receipts/${receipt.sha256}.json`,
      );
  return size === receipt.byte_count
    ? []
    : ['the quality receipt is not stored as referenced'];
}

/** The candidate of a prepared task: exactly the outputs its prepare units saved and its quality
 *  unit checked, with the quality receipt itself stored as referenced. */
async function candidateOf(
  db: D1Database,
  stored: Stored,
  recipe: Recipe,
  succeeded: Map<string, JobResult>,
) {
  const problems: string[] = [];
  const quality = recipe.units!.filter(unit => unit.kind === 'quality');
  if (quality.length !== 1)
    problems.push('the recipe must have exactly one quality unit');
  const result =
    quality.length === 1 ? succeeded.get(quality[0].unit_id) : undefined;
  const receipt = result?.quality_receipt_ref ?? null;
  problems.push(...receiptProblems(stored, receipt));
  const checked = await resolve(db, result?.output_refs ?? [], 'quality');
  const prepared = await resolve(
    db,
    recipe
      .units!.filter(unit => unit.kind === 'prepare')
      .flatMap(unit => succeeded.get(unit.unit_id)?.output_refs ?? []),
    'prepared',
  );
  problems.push(...checked.problems, ...prepared.problems);
  for (const id of checked.ids)
    if (!prepared.ids.has(id))
      problems.push(`checked output ${id} was not prepared by this task`);
  for (const id of prepared.ids)
    if (!checked.ids.has(id))
      problems.push(`prepared output ${id} was not quality-checked`);
  return {
    problems,
    ids: [...checked.ids].sort(),
    receipt,
    extent: quality[0]?.native_extent ?? {},
  };
}

interface CoverageRow {
  output_id: string;
  capability: string;
  state: string;
  native_extent_json: string;
}

/** Every source revision an output was prepared from must be named in the task. */
async function namedProblems(
  db: D1Database,
  scope: Scope,
  candidate: Output[],
) {
  const problems: string[] = [];
  const instructed = new Set(
    scope.inputs
      .filter(ref => ref.kind === 'source_revision')
      .map(ref => ref.id),
  );
  const revisions = [...new Set(candidate.flatMap(item => item.revisions))];
  const sourceRevisions = new Set(
    (
      await inChunks<{id: string}>(
        db,
        marks =>
          `SELECT id FROM source_nodes WHERE kind = 'source_revision' AND id IN (${marks})`,
        revisions,
      )
    ).map(row => row.id),
  );
  for (const item of candidate)
    for (const revision of item.revisions)
      if (
        (sourceRevisions.has(revision) || revision === item.revisions[0]) &&
        !instructed.has(revision)
      )
        problems.push(
          `output ${item.id} was prepared from ${revision}, which the task does not name`,
        );
  return problems;
}

/** Actual extent: the recipe's checked unit list; every output inside it. */
function extentProblems(
  candidate: Output[],
  extent: Record<string, unknown>,
  wanted: string[] | null,
) {
  if (!wanted)
    return [
      'the quality unit must list its native unit_ids; other extent shapes are not supported',
    ];
  const allowed = new Set(wanted);
  const problems: string[] = [];
  for (const item of candidate) {
    const actual = units(item.extent);
    if (
      !actual ||
      item.extent.coordinate_version !== extent.coordinate_version ||
      actual.some(unit => !allowed.has(unit))
    )
      problems.push(
        `output ${item.id} covers units outside the instructed extent`,
      );
  }
  return problems;
}

/** Capabilities: every instructed capability is available coverage over every unit. */
function capabilityProblems(
  coverage: CoverageRow[],
  capabilities: string[],
  wanted: string[] | null,
) {
  const problems: string[] = [];
  for (const capability of capabilities) {
    const covered = new Set(
      coverage
        .filter(
          row => row.capability === capability && row.state === 'available',
        )
        .flatMap(
          row =>
            units(
              JSON.parse(row.native_extent_json) as Record<string, unknown>,
            ) ?? [],
        ),
    );
    const missing = (wanted ?? []).filter(unit => !covered.has(unit));
    if (!covered.size)
      problems.push(`capability ${capability} is not available`);
    else if (missing.length)
      problems.push(
        `capability ${capability} is not available for ${missing.length} unit(s), first ${missing[0]}`,
      );
  }
  return problems;
}

/** Scope check of a prepared candidate against the owner's instruction. */
export async function scopeCheck(
  db: D1Database,
  stored: Stored,
  task: TaskRow,
  recipe: Recipe,
  succeeded: Map<string, JobResult>,
) {
  const scope = JSON.parse(task.scope_json) as Scope;
  const found = await candidateOf(db, stored, recipe, succeeded);
  const candidate = await outputs(db, found.ids);
  const wanted = units(found.extent);
  const coverage = await inChunks<CoverageRow>(
    db,
    marks =>
      `SELECT output_id, capability, state, native_extent_json FROM coverage WHERE output_id IN (${marks})`,
    found.ids,
  );
  const problems = [
    ...found.problems,
    ...(candidate.length ? [] : ['the candidate has no saved outputs']),
    ...(await namedProblems(db, scope, candidate)),
    ...extentProblems(candidate, found.extent, wanted),
    ...capabilityProblems(coverage, scope.capabilities, wanted),
  ];
  const report = {
    task_id: task.id,
    task_revision: task.revision,
    basis_digest: task.basis_digest,
    recipe_revision: recipe.revision,
    quality_receipt: found.receipt,
    candidate: found.ids,
    extent: found.extent,
    capabilities: scope.capabilities,
    coverage_rows: coverage.length,
    coverage_not_available: coverage.filter(row => row.state !== 'available')
      .length,
  };
  return {problems, candidate, receipt: found.receipt, report, coverage};
}
