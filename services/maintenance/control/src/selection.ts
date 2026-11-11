import { canonicalJson, sha256, type D1Database } from './d1.ts';
import { CONTRACT_VERSION, type JobResult, type Recipe } from './contracts.ts';
import type { DecisionRef, Outcome, Scope, TaskRow } from './tasks.ts';

/** Scope check, release construction and checked selection (Maintenance Control To-Be §4, MC-03).
 *
 *  Data Preparation's quality receipt says the candidate is sound. Control checks separately
 *  that the candidate is what the owner instructed, that everything it references exists and is
 *  admitted, and only then selects a release in one conditional D1 transaction. A failed check
 *  or guard leaves the current release unchanged. Nothing here deletes data. */

/** Control's view of the private bucket: object sizes by key prefix, in pages. */
export interface ObjectStore {
  list(prefix: string, cursor?: string): Promise<{ objects: Array<{ key: string; size: number }>; cursor?: string }>;
}

export const FORMATS = new Set(['text/utf-8', 'application/x-ndjson', 'application/json']);
const SCHEMA_VERSIONS = { job_contract: CONTRACT_VERSION, quality_receipt: 'preparation-quality/1', migrations: '0004' };
const MAX_LIST_PAGES = 100;   // At most 100,000 stored objects checked in one request.
const CHUNK = 50;             // D1 binds at most 100 parameters per statement.

interface OutputRow { id: string; kind: string; input_revisions_json: string; native_extent_json: string; validation_basis_json: string }
interface Output { id: string; kind: string; revisions: string[]; extent: Record<string, unknown>; dependencies: string[] }
interface ArtifactRow { id: string; output_id: string; byte_count: number; format: string; registered_locator: string }
export type Check = { problems: string[]; notes: string[] };
type SelectResult = { state: string; limitation?: string };

const parseOutput = (row: OutputRow): Output => ({
  id: row.id, kind: row.kind, revisions: JSON.parse(row.input_revisions_json) as string[],
  extent: JSON.parse(row.native_extent_json) as Record<string, unknown>,
  dependencies: ((JSON.parse(row.validation_basis_json) as { dependencies?: string[] }).dependencies) ?? [],
});
const units = (extent: Record<string, unknown>) => Array.isArray(extent.unit_ids) ? extent.unit_ids as string[] : null;

async function inChunks<T>(db: D1Database, sql: (marks: string) => string, ids: string[]): Promise<T[]> {
  const rows: T[] = [];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    rows.push(...(await db.prepare(sql(chunk.map(() => '?').join(','))).bind(...chunk).all<T>()).results);
  }
  return rows;
}

async function outputs(db: D1Database, ids: string[]): Promise<Output[]> {
  return (await inChunks<OutputRow>(db, marks => `SELECT id, kind, input_revisions_json, native_extent_json, validation_basis_json
    FROM prepared_outputs WHERE id IN (${marks})`, ids)).map(parseOutput);
}

async function members(db: D1Database, releaseId: string | null): Promise<Output[]> {
  if (!releaseId) return [];
  return (await db.prepare(`SELECT po.id, po.kind, po.input_revisions_json, po.native_extent_json, po.validation_basis_json
    FROM release_outputs ro JOIN prepared_outputs po ON po.id = ro.output_id WHERE ro.release_id = ?`)
    .bind(releaseId).all<OutputRow>()).results.map(parseOutput);
}

export async function selection(db: D1Database) {
  return (await db.prepare('SELECT current_release_id, previous_release_id FROM release_selection WHERE singleton_id = 1')
    .first<{ current_release_id: string | null; previous_release_id: string | null }>())!;
}

/** Every stored object under `prepared/`, by key. Null when the bucket holds more than one request can list. */
async function storedSizes(objects: ObjectStore): Promise<Map<string, number> | null> {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await objects.list('prepared/', cursor);
    for (const item of listed.objects) sizes.set(item.key, item.size);
    if (!listed.cursor) return sizes;
    cursor = listed.cursor;
  }
  return null;
}

/** References, formats, admissions, exclusions and statements of a set of outputs. Shared by
 *  promotion, rollback and restore validation, so all three pass the same checks. */
export async function checkReferences(db: D1Database, objects: ObjectStore | null, items: Output[],
  options: { statement?: DecisionRef | null; lifted?: Set<string> } = {}): Promise<Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  const ids = items.map(item => item.id);
  const found = new Set((await outputs(db, ids)).map(item => item.id));
  for (const id of ids) if (!found.has(id)) problems.push(`output ${id} is not saved`);

  const artifacts = await inChunks<ArtifactRow>(db, marks => `SELECT id, output_id, byte_count, format, registered_locator
    FROM artifacts WHERE output_id IN (${marks})`, ids);
  for (const artifact of artifacts) if (!FORMATS.has(artifact.format)) problems.push(`artifact ${artifact.id} has unsupported format ${artifact.format}`);
  if (artifacts.length) {
    if (!objects) problems.push('stored objects cannot be checked: Control has no bucket binding');
    else {
      const sizes = await storedSizes(objects);
      if (!sizes) problems.push('too many stored objects to check in one request');
      else for (const artifact of artifacts) {
        const size = sizes.get(artifact.registered_locator);
        if (size === undefined) problems.push(`artifact ${artifact.id} is missing from storage`);
        else if (size !== artifact.byte_count) problems.push(`artifact ${artifact.id} has ${size} bytes, ${artifact.byte_count} recorded`);
      }
    }
  }

  // Every input revision that is a source revision must be admitted for both hosts.
  const revisions = [...new Set(items.flatMap(item => item.revisions))];
  const nodes = new Map((await inChunks<{ id: string; kind: string }>(db, marks => `SELECT id, kind FROM source_nodes WHERE id IN (${marks})`, revisions))
    .map(row => [row.id, row.kind]));
  const statementOutputs = new Set((await inChunks<{ output_id: string }>(db, marks =>
    `SELECT output_id FROM character_statements WHERE output_id IN (${marks})`, ids)).map(row => row.output_id));
  for (const item of items) {
    const primary = item.revisions[0];
    // A statement is the owner's text, not prepared from a source revision.
    if (!statementOutputs.has(item.id) && nodes.get(primary) !== 'source_revision') problems.push(`output ${item.id} has no saved source revision ${primary}`);
  }
  const sourceRevisions = revisions.filter(id => nodes.get(id) === 'source_revision');
  const admitted = new Map((await inChunks<{ source_revision_id: string; total: number; eligible: number }>(db, marks =>
    `SELECT source_revision_id, COUNT(*) AS total, SUM(both_hosts_eligible = 1) AS eligible FROM admissions
     WHERE source_revision_id IN (${marks}) GROUP BY source_revision_id`, sourceRevisions)).map(row => [row.source_revision_id, row]));
  for (const id of sourceRevisions) {
    const row = admitted.get(id);
    if (!row || row.total === 0 || row.eligible !== row.total) problems.push(`source revision ${id} is not admitted for both hosts`);
  }
  const other = revisions.filter(id => !nodes.has(id));
  if (other.length) notes.push(`analysis revisions attributed by the reviewed recipe: ${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''}`);

  // Active exclusions apply to a source revision, any of its ancestors or an admitted component.
  // An owner decision of kind "exclusion" on a task that adds data lifts that exclusion.
  const excluded = new Set((await db.prepare('SELECT source_or_component_id FROM maintenance_exclusions WHERE active = 1')
    .all<{ source_or_component_id: string }>()).results.map(row => row.source_or_component_id)
    .filter(id => !options.lifted?.has(id)));
  if (excluded.size && sourceRevisions.length) {
    for (const revision of sourceRevisions) {
      const ids = await db.prepare(`WITH RECURSIVE up(id, parent) AS (SELECT id, parent_id FROM source_nodes WHERE id = ?
          UNION SELECT s.id, s.parent_id FROM source_nodes s JOIN up ON s.id = up.parent)
        SELECT id FROM up UNION SELECT component FROM admissions WHERE source_revision_id = ?`).bind(revision, revision).all<{ id: string }>();
      const hit = ids.results.find(row => excluded.has(row.id));
      if (hit) problems.push(`source revision ${revision} is excluded by the owner (${hit.id})`);
    }
  }

  // At most one statement per release, and only the owner-approved name and version.
  const statements = await inChunks<{ output_id: string; name: string; version: string; status: string }>(db, marks =>
    `SELECT output_id, name, version, status FROM character_statements WHERE output_id IN (${marks})`, ids);
  if (statements.length > 1) problems.push('more than one character-of-God statement would be selected');
  for (const statement of statements) {
    const approved = options.statement;
    if (statement.status !== 'approved') problems.push(`statement ${statement.name} ${statement.version} is not approved`);
    else if (approved !== undefined && (!approved || approved.name !== statement.name || approved.version !== statement.version))
      problems.push(`statement ${statement.name} ${statement.version} is not the owner-approved version for this task`);
  }
  return { problems, notes };
}

/** The candidate of a prepared task: exactly the outputs its prepare units saved and its quality unit checked. */
async function candidateOf(db: D1Database, recipe: Recipe, succeeded: Map<string, JobResult>) {
  const problems: string[] = [];
  const quality = recipe.units!.filter(unit => unit.kind === 'quality');
  if (quality.length !== 1) problems.push('the recipe must have exactly one quality unit');
  const result = quality.length === 1 ? succeeded.get(quality[0].unit_id) : undefined;
  if (!result?.quality_receipt_ref) problems.push('no quality receipt');
  const outputIds = async (refs: string[]) => new Set((await inChunks<{ output_id: string | null }>(db, marks =>
    `SELECT DISTINCT output_id FROM artifacts WHERE id IN (${marks})`, refs)).map(row => row.output_id).filter((id): id is string => !!id));
  const checked = await outputIds(result?.output_refs.map(ref => ref.artifact_id) ?? []);
  const prepared = await outputIds(recipe.units!.filter(unit => unit.kind === 'prepare')
    .flatMap(unit => succeeded.get(unit.unit_id)?.output_refs.map(ref => ref.artifact_id) ?? []));
  for (const id of checked) if (!prepared.has(id)) problems.push(`checked output ${id} was not prepared by this task`);
  for (const id of prepared) if (!checked.has(id)) problems.push(`prepared output ${id} was not quality-checked`);
  return { problems, ids: [...checked].sort(), receipt: result?.quality_receipt_ref ?? null, extent: quality[0]?.native_extent ?? {} };
}

const overlaps = (a: Output, b: Output) => {
  if (a.kind !== b.kind || a.revisions[0] !== b.revisions[0] || a.extent.coordinate_version !== b.extent.coordinate_version) return false;
  const left = units(a.extent);
  const right = units(b.extent);
  if (!left || !right) return canonicalJson(a.extent) === canonicalJson(b.extent);
  const set = new Set(left);
  return right.some(unit => set.has(unit));
};

/** Base members kept, plus the candidate. Same-kind outputs of the same source revision over
 *  overlapping native units are replaced; `replaces` drops whole source revisions. A kept output
 *  that depends on a dropped one is a problem: the task would leave it pointing at nothing. */
export function membership(base: Output[], candidate: Output[], replaces: Set<string>, removes: Set<string>) {
  const candidateIds = new Set(candidate.map(item => item.id));
  const dropped = base.filter(item => !candidateIds.has(item.id)
    && (replaces.has(item.revisions[0]) || removes.has(item.revisions[0]) || candidate.some(next => overlaps(item, next))));
  const droppedIds = new Set(dropped.map(item => item.id));
  const kept = base.filter(item => !droppedIds.has(item.id));
  const all = [...kept, ...candidate.filter(item => !kept.some(old => old.id === item.id))];
  const problems = kept.filter(item => item.dependencies.some(dependency => droppedIds.has(dependency)))
    .map(item => `kept output ${item.id} depends on an output this task drops`);
  const ids = new Set(all.map(item => item.id));
  for (const item of candidate) for (const dependency of item.dependencies)
    if (!ids.has(dependency)) problems.push(`output ${item.id} depends on ${dependency}, which would not be selected`);
  return { ids: [...ids].sort(), dropped: [...droppedIds].sort(), problems };
}

/** Scope check of a prepared candidate against the owner's instruction. */
export async function scopeCheck(db: D1Database, objects: ObjectStore | null, task: TaskRow, recipe: Recipe, succeeded: Map<string, JobResult>) {
  const scope = JSON.parse(task.scope_json) as Scope;
  const found = await candidateOf(db, recipe, succeeded);
  const problems = [...found.problems];
  const candidate = await outputs(db, found.ids);
  if (!candidate.length) problems.push('the candidate has no saved outputs');

  const instructed = new Set(scope.inputs.filter(ref => ref.kind === 'source_revision').map(ref => ref.id));
  for (const item of candidate) if (!instructed.has(item.revisions[0])) problems.push(`output ${item.id} was prepared from ${item.revisions[0]}, which the task does not name`);

  // Actual extent: the outputs together cover exactly the recipe's checked extent.
  const wanted = units(found.extent);
  if (wanted) {
    const coordinates = found.extent.coordinate_version;
    for (const item of candidate) {
      const actual = units(item.extent);
      if (!actual || (coordinates !== undefined && item.extent.coordinate_version !== coordinates) || actual.some(unit => !wanted.includes(unit)))
        problems.push(`output ${item.id} covers units outside the instructed extent`);
    }
  }
  // Capabilities: every instructed capability is available coverage over the whole extent.
  const coverage = await inChunks<{ output_id: string; capability: string; state: string; native_extent_json: string }>(db, marks =>
    `SELECT output_id, capability, state, native_extent_json FROM coverage WHERE output_id IN (${marks})`, found.ids);
  for (const capability of scope.capabilities) {
    const rows = coverage.filter(row => row.capability === capability && row.state === 'available');
    if (!rows.length) { problems.push(`capability ${capability} is not available`); continue; }
    if (wanted) {
      const covered = new Set(rows.flatMap(row => units(JSON.parse(row.native_extent_json)) ?? []));
      const missing = wanted.filter(unit => !covered.has(unit));
      if (missing.length) problems.push(`capability ${capability} is not available for ${missing.length} unit(s), first ${missing[0]}`);
    }
  }
  const partial = coverage.filter(row => row.state !== 'available').length;
  const statement = scope.kind === 'incorporate_statement' ? scope.decision_refs.find(ref => ref.kind === 'statement') ?? null : null;
  const references = await checkReferences(db, objects, candidate, { statement: scope.kind === 'incorporate_statement' ? statement : null,
    lifted: new Set(liftedBy(scope)) });
  problems.push(...references.problems);
  const report = {
    task_id: task.id, task_revision: task.revision, basis_digest: task.basis_digest, recipe_revision: recipe.revision,
    quality_receipt: found.receipt, candidate: found.ids, extent: found.extent, capabilities: scope.capabilities,
    coverage_rows: coverage.length, coverage_not_available: partial, notes: references.notes, problems,
  };
  return { problems, candidate, receipt: found.receipt, report, coverage };
}

/** Exclusions the owner lifts with this task: exclusion decisions on a task that adds data. */
const liftedBy = (scope: Scope) => scope.kind === 'remove' ? []
  : scope.decision_refs.filter(ref => ref.kind === 'exclusion' && ref.subject).map(ref => ref.subject!);

/** Promote a checked candidate: record the release and `checked` in one guarded batch, then
 *  select it in a second batch guarded by base, task revision, candidate and exclusions. */
async function promote(db: D1Database, task: TaskRow, release: { members: string[]; manifest: string; recipe: string;
  quality: string; scope: string; coverage: string; base: string | null; exclusions?: DecisionRef[]; lifts?: string[] }, outcome: Outcome): Promise<SelectResult> {
  const releaseId = `release-${(await sha256(canonicalJson({ members: release.members, quality: release.quality, scope: release.scope }))).slice(0, 32)}`;
  const active = await db.prepare('SELECT COUNT(*) AS total, SUM(active) AS active FROM maintenance_exclusions')
    .first<{ total: number; active: number | null }>();
  const guardTask = 'EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state IN (\'queued\',\'running\',\'checked\'))';
  const checked: Outcome = { ...outcome, checks: { quality: 'passed', scope: 'passed' } };
  const [, , record] = await db.batch([
    db.prepare(`INSERT INTO releases(id, manifest_revision, recipe_revision, schema_versions_json, coverage_basis, quality_receipt, scope_receipt)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guardTask} AND NOT EXISTS (SELECT 1 FROM releases WHERE id = ?)`)
      .bind(releaseId, release.manifest, release.recipe, canonicalJson(SCHEMA_VERSIONS), release.coverage, release.quality, release.scope,
        task.id, task.revision, releaseId),
    db.prepare(`INSERT OR IGNORE INTO release_outputs(release_id, output_id) SELECT ?, value FROM json_each(?)
      WHERE ${guardTask} AND NOT EXISTS (SELECT 1 FROM release_selection WHERE ? IN (current_release_id, previous_release_id))`)
      .bind(releaseId, JSON.stringify(release.members), task.id, task.revision, releaseId),
    db.prepare(`UPDATE maintenance_tasks SET state = 'checked', revision = revision + 1, base_release_id = ?, candidate_release_id = ?,
        quality_ref = ?, scope_ref = ?, outcome_json = ? WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')
        AND (SELECT COUNT(*) FROM release_outputs WHERE release_id = ?) = ?`)
      .bind(release.base, releaseId, release.quality, release.scope, canonicalJson(checked), task.id, task.revision, releaseId, release.members.length),
  ]);
  if (!record.meta.changes) {
    const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
    return { state: now?.state ?? 'unknown' };
  }
  const revision = task.revision + 1;
  const done: Outcome = { ...checked, selection: { current_release_id: releaseId, became_current: true } };
  const exclusions = (release.exclusions ?? []).filter(ref => ref.subject);
  const guardSelected = `(SELECT current_release_id FROM release_selection WHERE singleton_id = 1) = ?`;
  const statements = [
    db.prepare(`UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = ?
      WHERE singleton_id = 1 AND current_release_id IS ? AND ? IS NOT current_release_id
        AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'checked' AND candidate_release_id = ?)
        AND (SELECT COUNT(*) FROM maintenance_exclusions) = ? AND (SELECT COALESCE(SUM(active), 0) FROM maintenance_exclusions) = ?`)
      .bind(releaseId, release.base, releaseId, task.id, revision, releaseId, active?.total ?? 0, active?.active ?? 0),
    ...exclusions.map(ref => db.prepare(`INSERT INTO maintenance_exclusions(source_or_component_id, decision_ref, task_id, revision, active)
      SELECT ?, ?, ?, ?, 1 WHERE ${guardSelected} ON CONFLICT(source_or_component_id, decision_ref) DO UPDATE SET active = 1, revision = excluded.revision`)
      .bind(ref.subject, ref.ref, task.id, revision, releaseId)),
    ...(release.lifts ?? []).map(subject => db.prepare(`UPDATE maintenance_exclusions SET active = 0, revision = ?
      WHERE source_or_component_id = ? AND active = 1 AND ${guardSelected}`).bind(revision, subject, releaseId)),
    db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
      WHERE id = ? AND revision = ? AND state = 'checked' AND ${guardSelected}`).bind(canonicalJson(done), task.id, revision, releaseId),
  ];
  try { await db.batch(statements); }
  catch { /* A lost response: the read below decides. */ }
  const [now, current] = await Promise.all([
    db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>(),
    selection(db),
  ]);
  if (now?.state === 'completed') return { state: 'completed' };
  return { state: now?.state ?? 'unknown', limitation: current.current_release_id === releaseId ? undefined
    : 'The current release changed before selection; the next check rebuilds the release from the new current release.' };
}

async function block(db: D1Database, task: TaskRow, outcome: Outcome, problems: string[], report?: unknown): Promise<SelectResult> {
  const next = { ...outcome, limitations: [...new Set([...outcome.limitations, ...problems.slice(0, 20)])],
    checks: { ...(outcome as { checks?: object }).checks, scope: 'failed' }, ...(report ? { scope_report: report } : {}) };
  await db.prepare(`UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1, outcome_json = ?
    WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`).bind(canonicalJson(next), task.id, task.revision).run();
  return { state: 'blocked', limitation: problems[0] };
}

async function complete(db: D1Database, task: TaskRow, outcome: Outcome, change: Partial<Outcome> & Record<string, unknown>): Promise<SelectResult> {
  await db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
    WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`).bind(canonicalJson({ ...outcome, ...change }), task.id, task.revision).run();
  return { state: 'completed' };
}

/** All units of a prepared task succeeded: check scope, build the release, select it. */
export async function checkAndSelect(db: D1Database, objects: ObjectStore | null, task: TaskRow, recipe: Recipe, succeeded: Map<string, JobResult>): Promise<SelectResult> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  const checked = await scopeCheck(db, objects, task, recipe, succeeded);
  const current = await selection(db);
  const replaces = new Set(Array.isArray(scope.constraints.replaces) ? scope.constraints.replaces as string[] : []);
  const base = await members(db, current.current_release_id);
  // A new statement replaces the selected one; ordinary sources stay usable without one.
  const statementOutputs = scope.kind === 'incorporate_statement'
    ? new Set((await inChunks<{ output_id: string }>(db, marks => `SELECT output_id FROM character_statements WHERE output_id IN (${marks})`,
      base.map(item => item.id))).map(row => row.output_id)) : new Set<string>();
  const built = membership(base.filter(item => !statementOutputs.has(item.id)), checked.candidate, replaces, new Set());
  const problems = [...checked.problems, ...built.problems];
  const report = { ...checked.report, base_release_id: current.current_release_id, dropped: built.dropped, problems };
  if (problems.length) return block(db, task, outcome, problems, report);
  const scopeRef = `sha256:${await sha256(canonicalJson(report))}`;
  const coverage = `sha256:${await sha256(canonicalJson(checked.coverage.map(row => [row.output_id, row.capability, row.state]).sort()))}`;
  const quality = `${checked.receipt!.artifact_id}@${checked.receipt!.sha256}`;
  return promote(db, task, { members: built.ids, manifest: recipe.manifest_revision!, recipe: recipe.revision, quality,
    scope: scopeRef, coverage, base: current.current_release_id, lifts: liftedBy(scope) }, { ...outcome, scope_report: report } as Outcome);
}

/** Validate a selected or selectable release: every member and artifact, admission, exclusions, statements. */
export async function validateRelease(db: D1Database, objects: ObjectStore | null, releaseId: string): Promise<Check> {
  const release = await db.prepare('SELECT id FROM releases WHERE id = ?').bind(releaseId).first();
  if (!release) return { problems: [`release ${releaseId} is not saved`], notes: [] };
  const items = await members(db, releaseId);
  const listed = (await db.prepare('SELECT COUNT(*) AS total FROM release_outputs WHERE release_id = ?').bind(releaseId).first<{ total: number }>())!.total;
  const check = await checkReferences(db, objects, items);
  if (listed !== items.length) check.problems.unshift(`release ${releaseId} lists ${listed - items.length} output(s) that are not saved`);
  if (!items.length) check.problems.unshift(`release ${releaseId} has no outputs`);
  return check;
}

/** Remove, rollback and restore validation: no preparation, the same checks and gate. */
export async function selectDirect(db: D1Database, objects: ObjectStore | null, task: TaskRow): Promise<SelectResult> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  const current = await selection(db);

  if (scope.kind === 'remove') {
    if (!current.current_release_id) return complete(db, task, outcome, { limitations: [...outcome.limitations, 'Nothing is current, so nothing was removed.'],
      selection: { current_release_id: null, became_current: false } });
    const removes = new Set(scope.inputs.filter(ref => ref.kind === 'source_revision').map(ref => ref.id));
    const base = await members(db, current.current_release_id);
    const built = membership(base, [], new Set(), removes);
    if (built.problems.length) return block(db, task, outcome, built.problems);
    if (!built.dropped.length) return complete(db, task, outcome, { limitations: [...outcome.limitations, 'The current release holds none of the named sources.'],
      selection: { current_release_id: current.current_release_id, became_current: false } });
    if (!built.ids.length) return block(db, task, outcome, ['Removing these sources would leave no data selected; nothing was changed.']);
    const report = { task_id: task.id, task_revision: task.revision, removed: built.dropped, base_release_id: current.current_release_id };
    const digest = `sha256:${await sha256(canonicalJson(report))}`;
    const prior = await db.prepare('SELECT manifest_revision, recipe_revision, quality_receipt, coverage_basis FROM releases WHERE id = ?')
      .bind(current.current_release_id).first<{ manifest_revision: string; recipe_revision: string; quality_receipt: string; coverage_basis: string }>();
    return promote(db, task, { members: built.ids, manifest: prior!.manifest_revision, recipe: prior!.recipe_revision,
      quality: `control-removal:${digest}`, scope: digest, coverage: prior!.coverage_basis, base: current.current_release_id,
      exclusions: scope.decision_refs.filter(ref => ref.kind === 'exclusion') }, { ...outcome, removal_report: report } as Outcome);
  }

  if (scope.kind === 'rollback') {
    if (!current.previous_release_id) return complete(db, task, outcome, {
      limitations: [...outcome.limitations, 'No previous release is available; the current release is unchanged.'],
      selection: { current_release_id: current.current_release_id, became_current: false } });
    const check = await validateRelease(db, objects, current.previous_release_id);
    if (check.problems.length) return complete(db, task, outcome, {
      limitations: [...outcome.limitations, 'The previous release is not eligible; the current release is unchanged.', ...check.problems.slice(0, 20)],
      selection: { current_release_id: current.current_release_id, became_current: false } });
    return swap(db, task, outcome, current.current_release_id!, current.previous_release_id, check);
  }

  // validate_restore: report on the restored selection; select a restored release only when instructed.
  const notes: string[] = [];
  const results: Record<string, Check> = {};
  for (const id of [current.current_release_id, current.previous_release_id].filter((value): value is string => !!value))
    results[id] = await validateRelease(db, objects, id);
  // Restored running work is never restarted by itself: it is blocked until the owner resumes it.
  const open = (await db.prepare(`SELECT id, revision FROM maintenance_tasks WHERE id <> ? AND state IN ('queued','running','checked')`)
    .bind(task.id).all<{ id: string; revision: number }>()).results;
  for (const item of open) {
    const changed = await db.prepare(`UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1,
        outcome_json = json_set(outcome_json, '$.limitations', json_insert(json_extract(outcome_json, '$.limitations'), '$[#]', ?))
      WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`)
      .bind(`Blocked by restore validation in ${task.id}; check the restored state, then resume.`, item.id, item.revision).run();
    if (changed.meta.changes) notes.push(`task ${item.id} was open in the restored state and is now blocked until resumed`);
  }
  const wanted = typeof scope.constraints.select_release === 'string' ? scope.constraints.select_release : null;
  const report = { releases: results, notes };
  if (wanted && wanted !== current.current_release_id) {
    const check = await validateRelease(db, objects, wanted);
    if (check.problems.length) return complete(db, task, outcome, { restore_report: report,
      limitations: [...outcome.limitations, `Release ${wanted} is not eligible; the current release is unchanged.`, ...check.problems.slice(0, 20)],
      selection: { current_release_id: current.current_release_id, became_current: false } });
    return swap(db, task, { ...outcome, restore_report: report } as Outcome, current.current_release_id, wanted, check);
  }
  const problems = Object.entries(results).flatMap(([id, check]) => check.problems.map(problem => `${id}: ${problem}`));
  return complete(db, task, outcome, { restore_report: report,
    limitations: [...outcome.limitations, ...(problems.length ? problems.slice(0, 20) : ['The restored releases passed validation.'])],
    selection: { current_release_id: current.current_release_id, became_current: false } });
}

/** Select an existing, validated release; the previously current one becomes previous. */
async function swap(db: D1Database, task: TaskRow, outcome: Outcome, base: string | null, target: string, check: Check): Promise<SelectResult> {
  const active = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM maintenance_exclusions')
    .first<{ total: number; active: number }>();
  const done: Outcome = { ...outcome, limitations: [...outcome.limitations, ...check.notes],
    selection: { current_release_id: target, became_current: true } };
  try {
    await db.batch([
      db.prepare(`UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = ?
        WHERE singleton_id = 1 AND current_release_id IS ? AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ?
          AND state IN ('queued','running')) AND (SELECT COUNT(*) FROM maintenance_exclusions) = ?
          AND (SELECT COALESCE(SUM(active), 0) FROM maintenance_exclusions) = ?`)
        .bind(target, base, task.id, task.revision, active!.total, active!.active),
      db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, base_release_id = ?, candidate_release_id = ?,
          outcome_json = ? WHERE id = ? AND revision = ? AND (SELECT current_release_id FROM release_selection WHERE singleton_id = 1) = ?`)
        .bind(base, target, canonicalJson(done), task.id, task.revision, target),
    ]);
  } catch { /* A lost response: the read below decides. */ }
  const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
  return { state: now?.state ?? 'unknown', ...(now?.state === 'completed' ? {} : { limitation: 'The selection changed during the check; check the task again.' }) };
}
