import { canonicalJson, sha256, type D1Database } from './d1.ts';
import type { ArtifactRef, JobResult, Recipe } from './contracts.ts';
import type { DecisionRef, Outcome, Scope, TaskRow } from './tasks.ts';

/** Scope check, release construction and checked selection (Maintenance Control To-Be §4, MC-03).
 *
 *  Data Preparation's quality receipt says the candidate is sound. Control checks separately
 *  that the candidate is what the owner instructed and that the whole resulting release is
 *  complete, stored, admitted and not excluded, and only then selects it in a conditional D1
 *  transaction. A failed check or guard leaves the current release unchanged. Nothing here
 *  deletes data. */

/** Control's view of the private bucket: object sizes by key prefix, in pages. */
export interface ObjectStore {
  list(prefix: string, cursor?: string): Promise<{ objects: Array<{ key: string; size: number }>; cursor?: string }>;
}

export const FORMATS = new Set(['text/utf-8', 'application/x-ndjson', 'application/json']);
/** Data format versions of a release, as `infrastructure/github/deployment/compatibility.json`
 *  lists them: deployment refuses code that does not support the selected release's versions. */
export const SCHEMA_VERSIONS = { evidence_records: '1', native_reference: '1', index_manifest: '2' };
const MAX_LIST_PAGES = 100;   // At most 100,000 stored objects checked in one request.
const CHUNK = 50;             // D1 binds at most 100 parameters per statement.
const BLOCK_TRIES = 5;
const INDEX_FILES: Record<string, string[]> = {
  source_search: ['application/x-ndjson', 'application/json'], word_index: ['application/x-ndjson', 'application/json'],
};

interface OutputRow { id: string; kind: string; input_revisions_json: string; native_extent_json: string; validation_basis_json: string }
export interface Output { id: string; kind: string; revisions: string[]; extent: Record<string, unknown>; dependencies: string[] }
interface ArtifactRow { id: string; output_id: string | null; sha256: string; byte_count: number; format: string; registered_locator: string }
export type Check = { problems: string[]; notes: string[] };
type SelectResult = { state: string; limitation?: string };
/** Stored object sizes, or why they could not be read. */
type Stored = Map<string, number> | 'no_binding' | 'too_many';

const parseOutput = (row: OutputRow): Output => ({
  id: row.id, kind: row.kind, revisions: JSON.parse(row.input_revisions_json) as string[],
  extent: JSON.parse(row.native_extent_json) as Record<string, unknown>,
  dependencies: ((JSON.parse(row.validation_basis_json) as { dependencies?: string[] }).dependencies) ?? [],
});
const units = (extent: Record<string, unknown>) =>
  Array.isArray(extent.unit_ids) && extent.unit_ids.length && extent.unit_ids.every(unit => typeof unit === 'string') ? extent.unit_ids as string[] : null;

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

/** The exact exclusion state, as one comparable value. Read before any check that uses
 *  exclusions; the selection transaction requires it unchanged. */
const EXCLUSION_STATE = `(SELECT COALESCE(group_concat(entry, '|'), '') FROM (SELECT source_or_component_id || ':' || decision_ref
  || ':' || active || ':' || revision || ':' || task_id AS entry FROM maintenance_exclusions ORDER BY source_or_component_id, decision_ref))`;
async function exclusionState(db: D1Database) {
  return (await db.prepare(`SELECT ${EXCLUSION_STATE} AS state`).first<{ state: string }>())!.state;
}

/** Every stored object under `prepared/` (outputs and receipts), by key. */
async function storedSizes(objects: ObjectStore | null): Promise<Stored> {
  if (!objects) return 'no_binding';
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await objects.list('prepared/', cursor);
    for (const item of listed.objects) sizes.set(item.key, item.size);
    if (!listed.cursor) return sizes;
    cursor = listed.cursor;
  }
  return 'too_many';
}
const storageProblem = (stored: Stored) => stored === 'no_binding' ? 'stored objects cannot be checked: Control has no bucket binding'
  : stored === 'too_many' ? 'too many stored objects to check in one request' : null;

/** Everything a release needs, checked over its whole membership: saved outputs, dependency
 *  closure, stored artifacts with recorded sizes and supported formats, admission for both
 *  hosts, active exclusions and statements. Promotion, removal, rollback and restore all use it. */
export async function validateMembers(db: D1Database, stored: Stored, items: Output[],
  options: { approved?: DecisionRef | null; added?: Set<string>; lifted?: Set<string>; adding?: Set<string> } = {}): Promise<Check> {
  const problems: string[] = [];
  const notes: string[] = [];
  const ids = items.map(item => item.id);
  const found = new Set((await outputs(db, ids)).map(item => item.id));
  for (const id of ids) if (!found.has(id)) problems.push(`output ${id} is not saved`);
  const memberIds = new Set(ids);
  for (const item of items) for (const dependency of item.dependencies)
    if (!memberIds.has(dependency)) problems.push(`output ${item.id} depends on ${dependency}, which is not in the release`);

  const artifacts = await inChunks<ArtifactRow>(db, marks => `SELECT id, output_id, sha256, byte_count, format, registered_locator
    FROM artifacts WHERE output_id IN (${marks})`, ids);
  // Index outputs live only in their stored files: each needs its postings and its manifest.
  // Evidence may keep its wording in D1, so it needs no artifact.
  for (const item of items.filter(output => INDEX_FILES[output.kind])) {
    const formats = new Set(artifacts.filter(artifact => artifact.output_id === item.id).map(artifact => artifact.format));
    for (const format of INDEX_FILES[item.kind]) if (!formats.has(format)) problems.push(`index output ${item.id} has no ${format} file`);
  }
  for (const artifact of artifacts) if (!FORMATS.has(artifact.format)) problems.push(`artifact ${artifact.id} has unsupported format ${artifact.format}`);
  if (artifacts.length) {
    const problem = storageProblem(stored);
    if (problem) problems.push(problem);
    else for (const artifact of artifacts) {
      const size = (stored as Map<string, number>).get(artifact.registered_locator);
      if (size === undefined) problems.push(`artifact ${artifact.id} is missing from storage`);
      else if (size !== artifact.byte_count) problems.push(`artifact ${artifact.id} has ${size} bytes, ${artifact.byte_count} recorded`);
    }
  }

  const statements = await inChunks<{ output_id: string; name: string; version: string; status: string }>(db, marks =>
    `SELECT output_id, name, version, status FROM character_statements WHERE output_id IN (${marks})`, ids);
  const statementIds = new Set(statements.map(row => row.output_id));
  if (statements.length > 1) problems.push('more than one character-of-God statement would be selected');
  for (const statement of statements) {
    if (statement.status !== 'approved') problems.push(`statement ${statement.name} ${statement.version} is not approved`);
    // A statement this task adds must be exactly the owner's approved name and version.
    else if (options.added?.has(statement.output_id) && (!options.approved
        || options.approved.name !== statement.name || options.approved.version !== statement.version))
      problems.push(`statement ${statement.name} ${statement.version} is not the owner-approved version for this task`);
  }

  // Every input revision that is a source revision must be saved and admitted for both hosts.
  const revisions = [...new Set(items.flatMap(item => item.revisions))];
  const nodes = new Map((await inChunks<{ id: string; kind: string }>(db, marks => `SELECT id, kind FROM source_nodes WHERE id IN (${marks})`, revisions))
    .map(row => [row.id, row.kind]));
  for (const item of items)
    if (!statementIds.has(item.id) && nodes.get(item.revisions[0]) !== 'source_revision')
      problems.push(`output ${item.id} has no saved source revision ${item.revisions[0]}`);
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
  // An owner exclusion decision on a task that adds data lifts that exclusion.
  const excluded = new Set((await db.prepare('SELECT source_or_component_id FROM maintenance_exclusions WHERE active = 1')
    .all<{ source_or_component_id: string }>()).results.map(row => row.source_or_component_id)
    .filter(id => !options.lifted?.has(id)).concat([...(options.adding ?? [])]));
  if (excluded.size) for (const revision of sourceRevisions) {
    const related = await db.prepare(`WITH RECURSIVE up(id, parent) AS (SELECT id, parent_id FROM source_nodes WHERE id = ?
        UNION SELECT s.id, s.parent_id FROM source_nodes s JOIN up ON s.id = up.parent)
      SELECT id FROM up UNION SELECT component FROM admissions WHERE source_revision_id = ?`).bind(revision, revision).all<{ id: string }>();
    const hit = related.results.find(row => excluded.has(row.id));
    if (hit) problems.push(`source revision ${revision} is excluded by the owner (${hit.id})`);
  }
  return { problems, notes };
}

/** Resolve result references exactly: each must be a saved artifact with the stated digest and size. */
async function resolve(db: D1Database, refs: ArtifactRef[], what: string) {
  const problems: string[] = [];
  const rows = new Map((await inChunks<ArtifactRow>(db, marks => `SELECT id, output_id, sha256, byte_count, format, registered_locator
    FROM artifacts WHERE id IN (${marks})`, refs.map(ref => ref.artifact_id))).map(row => [row.id, row]));
  const ids = new Set<string>();
  for (const ref of refs) {
    const row = rows.get(ref.artifact_id);
    if (!row) problems.push(`${what} reference ${ref.artifact_id} is not a saved artifact`);
    else if (row.sha256 !== ref.sha256 || row.byte_count !== ref.byte_count) problems.push(`${what} reference ${ref.artifact_id} does not match the saved artifact`);
    else if (!row.output_id) problems.push(`${what} reference ${ref.artifact_id} belongs to no prepared output`);
    else ids.add(row.output_id);
  }
  return { problems, ids };
}

/** The candidate of a prepared task: exactly the outputs its prepare units saved and its quality
 *  unit checked, with the quality receipt itself stored as referenced. */
async function candidateOf(db: D1Database, stored: Stored, recipe: Recipe, succeeded: Map<string, JobResult>) {
  const problems: string[] = [];
  const quality = recipe.units!.filter(unit => unit.kind === 'quality');
  if (quality.length !== 1) problems.push('the recipe must have exactly one quality unit');
  const result = quality.length === 1 ? succeeded.get(quality[0].unit_id) : undefined;
  const receipt = result?.quality_receipt_ref ?? null;
  if (!receipt) problems.push('no quality receipt');
  else if (receipt.artifact_id !== `receipt:${receipt.sha256.slice(0, 32)}`) problems.push('the quality receipt reference is malformed');
  else if (!storageProblem(stored) && (stored as Map<string, number>).get(`prepared/receipts/${receipt.sha256}.json`) !== receipt.byte_count)
    problems.push('the quality receipt is not stored as referenced');
  const checked = await resolve(db, result?.output_refs ?? [], 'quality');
  const prepared = await resolve(db, recipe.units!.filter(unit => unit.kind === 'prepare')
    .flatMap(unit => succeeded.get(unit.unit_id)?.output_refs ?? []), 'prepared');
  problems.push(...checked.problems, ...prepared.problems);
  for (const id of checked.ids) if (!prepared.ids.has(id)) problems.push(`checked output ${id} was not prepared by this task`);
  for (const id of prepared.ids) if (!checked.ids.has(id)) problems.push(`prepared output ${id} was not quality-checked`);
  return { problems, ids: [...checked.ids].sort(), receipt, extent: quality[0]?.native_extent ?? {} };
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
 *  overlapping native units are replaced; `replaces` and `removes` drop whole source revisions.
 *  A kept output that depends on a dropped one is a problem: it would point at nothing. */
export function membership(base: Output[], candidate: Output[], replaces: Set<string>, removes: Set<string>) {
  const candidateIds = new Set(candidate.map(item => item.id));
  const dropped = base.filter(item => !candidateIds.has(item.id)
    && (replaces.has(item.revisions[0]) || removes.has(item.revisions[0]) || candidate.some(next => overlaps(item, next))));
  const droppedIds = new Set(dropped.map(item => item.id));
  const kept = base.filter(item => !droppedIds.has(item.id));
  const all = [...kept, ...candidate.filter(item => !kept.some(old => old.id === item.id))];
  const problems = kept.filter(item => item.dependencies.some(dependency => droppedIds.has(dependency)))
    .map(item => `kept output ${item.id} depends on an output this task drops`);
  return { ids: all.map(item => item.id).sort(), all, dropped: [...droppedIds].sort(), problems };
}

/** Scope check of a prepared candidate against the owner's instruction. */
export async function scopeCheck(db: D1Database, stored: Stored, task: TaskRow, recipe: Recipe, succeeded: Map<string, JobResult>) {
  const scope = JSON.parse(task.scope_json) as Scope;
  const found = await candidateOf(db, stored, recipe, succeeded);
  const problems = [...found.problems];
  const candidate = await outputs(db, found.ids);
  if (!candidate.length) problems.push('the candidate has no saved outputs');

  // Every source revision an output was prepared from must be named in the task.
  const instructed = new Set(scope.inputs.filter(ref => ref.kind === 'source_revision').map(ref => ref.id));
  const revisions = [...new Set(candidate.flatMap(item => item.revisions))];
  const sourceRevisions = new Set((await inChunks<{ id: string }>(db, marks =>
    `SELECT id FROM source_nodes WHERE kind = 'source_revision' AND id IN (${marks})`, revisions)).map(row => row.id));
  for (const item of candidate) for (const revision of item.revisions)
    if ((sourceRevisions.has(revision) || revision === item.revisions[0]) && !instructed.has(revision))
      problems.push(`output ${item.id} was prepared from ${revision}, which the task does not name`);

  // Actual extent: the recipe's checked unit list; every output inside it.
  const wanted = units(found.extent);
  if (!wanted) problems.push('the quality unit must list its native unit_ids; other extent shapes are not supported');
  else {
    const allowed = new Set(wanted);
    for (const item of candidate) {
      const actual = units(item.extent);
      if (!actual || item.extent.coordinate_version !== found.extent.coordinate_version || actual.some(unit => !allowed.has(unit)))
        problems.push(`output ${item.id} covers units outside the instructed extent`);
    }
  }
  // Capabilities: every instructed capability is available coverage over every unit.
  const coverage = await inChunks<{ output_id: string; capability: string; state: string; native_extent_json: string }>(db, marks =>
    `SELECT output_id, capability, state, native_extent_json FROM coverage WHERE output_id IN (${marks})`, found.ids);
  for (const capability of scope.capabilities) {
    const covered = new Set(coverage.filter(row => row.capability === capability && row.state === 'available')
      .flatMap(row => units(JSON.parse(row.native_extent_json) as Record<string, unknown>) ?? []));
    const missing = (wanted ?? []).filter(unit => !covered.has(unit));
    if (!covered.size) problems.push(`capability ${capability} is not available`);
    else if (missing.length) problems.push(`capability ${capability} is not available for ${missing.length} unit(s), first ${missing[0]}`);
  }
  const report = {
    task_id: task.id, task_revision: task.revision, basis_digest: task.basis_digest, recipe_revision: recipe.revision,
    quality_receipt: found.receipt, candidate: found.ids, extent: found.extent, capabilities: scope.capabilities,
    coverage_rows: coverage.length, coverage_not_available: coverage.filter(row => row.state !== 'available').length,
  };
  return { problems, candidate, receipt: found.receipt, report, coverage };
}

/** Exclusions the owner lifts with this task: exclusion decisions on a task that adds data. */
const liftedBy = (scope: Scope) => scope.kind === 'remove' ? []
  : scope.decision_refs.filter(ref => ref.kind === 'exclusion' && ref.subject).map(ref => ref.subject!);
const recordedBy = (scope: Scope) => scope.kind === 'remove' ? scope.decision_refs.filter(ref => ref.kind === 'exclusion' && ref.subject) : [];

/** Exclusion changes the task makes. They are written only after this very invocation completed
 *  the task: the guard matches the completion token it wrote, so a stale or repeated check whose
 *  own update failed can never replay them (for example after a later lift). */
function exclusionChanges(db: D1Database, scope: Scope, taskId: string, revision: number, token: string) {
  const guard = `EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'completed'
    AND json_extract(outcome_json, '$.completion') = ?)`;
  const guardValues = [taskId, revision + 1, token];
  return [
    ...recordedBy(scope).map(ref => db.prepare(`INSERT INTO maintenance_exclusions(source_or_component_id, decision_ref, task_id, revision, active)
      SELECT ?, ?, ?, ?, 1 WHERE ${guard} ON CONFLICT(source_or_component_id, decision_ref) DO UPDATE SET active = 1, revision = excluded.revision`)
      .bind(ref.subject, ref.ref, taskId, revision, ...guardValues)),
    ...liftedBy(scope).map(subject => db.prepare(`UPDATE maintenance_exclusions SET active = 0, revision = ?
      WHERE source_or_component_id = ? AND active = 1 AND ${guard}`).bind(revision, subject, ...guardValues)),
  ];
}

/** Promote a checked release: record the release and `checked` in one guarded batch, then select
 *  it in a second batch guarded by base, task revision, candidate and the checked exclusion state. */
async function promote(db: D1Database, task: TaskRow, release: { members: string[]; manifest: string; recipe: string;
  quality: string; scope: string; coverage: string; base: string | null; exclusions: string }, outcome: Outcome): Promise<SelectResult> {
  const scope = JSON.parse(task.scope_json) as Scope;
  const releaseId = `release-${(await sha256(canonicalJson({ members: release.members, quality: release.quality, scope: release.scope }))).slice(0, 32)}`;
  const guardTask = `EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state IN ('queued','running','checked'))`;
  const checked: Outcome = { ...outcome, checks: { ...outcome.checks, scope: 'passed' } };
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
        AND EXISTS (SELECT 1 FROM releases WHERE id = ?) AND (SELECT COUNT(*) FROM release_outputs WHERE release_id = ?) = ?`)
      .bind(release.base, releaseId, release.quality, release.scope, canonicalJson(checked), task.id, task.revision,
        releaseId, releaseId, release.members.length),
  ]);
  if (!record.meta.changes) {
    const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
    return { state: now?.state ?? 'unknown' };
  }
  const revision = task.revision + 1;
  const token = crypto.randomUUID();
  const done: Outcome = { ...checked, completion: token, selection: { current_release_id: releaseId, became_current: true } };
  const selected = `(SELECT current_release_id FROM release_selection WHERE singleton_id = 1) = ?`;
  try {
    await db.batch([
      db.prepare(`UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = ?
        WHERE singleton_id = 1 AND current_release_id IS ? AND ? IS NOT current_release_id
          AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ? AND state = 'checked' AND candidate_release_id = ?)
          AND ${EXCLUSION_STATE} = ?`)
        .bind(releaseId, release.base, releaseId, task.id, revision, releaseId, release.exclusions),
      db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
        WHERE id = ? AND revision = ? AND state = 'checked' AND ${selected} AND ${EXCLUSION_STATE} = ?`)
        .bind(canonicalJson(done), task.id, revision, releaseId, release.exclusions),
      ...exclusionChanges(db, scope, task.id, revision, token),
    ]);
  } catch { /* A lost response: the read below decides. */ }
  const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
  if (now?.state === 'completed') return { state: 'completed' };
  return { state: now?.state ?? 'unknown',
    limitation: 'The current release or the exclusions changed before selection; the next check rebuilds the release.' };
}

/** Block with the reasons. A quality check that passed is recorded as passed, with its receipt,
 *  even when the scope check fails. */
async function block(db: D1Database, task: TaskRow, outcome: Outcome, problems: string[], report?: unknown,
  quality?: string | null): Promise<SelectResult> {
  const next: Outcome = { ...outcome, limitations: [...new Set([...outcome.limitations, ...problems.slice(0, 20)])],
    checks: { ...outcome.checks, ...(quality ? { quality: 'passed' as const } : {}), scope: 'failed' },
    ...(report ? { scope_report: report as Outcome['scope_report'] } : {}) };
  await db.prepare(`UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1, outcome_json = ?,
      quality_ref = COALESCE(?, quality_ref) WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`)
    .bind(canonicalJson(next), quality ?? null, task.id, task.revision).run();
  return { state: 'blocked', limitation: problems[0] };
}

/** Finish without a selection change. The task's exclusion changes commit with it, and only if
 *  the exclusion state the task read is unchanged. */
async function complete(db: D1Database, task: TaskRow, outcome: Outcome, change: Partial<Outcome>, exclusions: string,
  current: string | null): Promise<SelectResult> {
  const scope = JSON.parse(task.scope_json) as Scope;
  const token = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, outcome_json = ?
        WHERE id = ? AND revision = ? AND state IN ('queued','running','checked') AND ${EXCLUSION_STATE} = ?
          AND (SELECT current_release_id FROM release_selection WHERE singleton_id = 1) IS ?`)
        .bind(canonicalJson({ ...outcome, ...change, completion: token }), task.id, task.revision, exclusions, current),
      ...exclusionChanges(db, scope, task.id, task.revision, token),
    ]);
  } catch { /* A lost response: the read below decides. */ }
  const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
  return { state: now?.state ?? 'unknown' };
}

/** All units of a prepared task succeeded: check scope, build the release, validate it whole, select it. */
export async function checkAndSelect(db: D1Database, objects: ObjectStore | null, task: TaskRow, recipe: Recipe, succeeded: Map<string, JobResult>): Promise<SelectResult> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  const exclusions = await exclusionState(db);   // Read first: the selection requires it unchanged.
  const current = await selection(db);
  const stored = await storedSizes(objects);
  const checked = await scopeCheck(db, stored, task, recipe, succeeded);
  const replaces = new Set(Array.isArray(scope.constraints.replaces) ? scope.constraints.replaces as string[] : []);
  const base = await members(db, current.current_release_id);
  // A new statement replaces the selected one; ordinary sources stay usable without one.
  const replacedStatements = scope.kind === 'incorporate_statement'
    ? new Set((await inChunks<{ output_id: string }>(db, marks => `SELECT output_id FROM character_statements WHERE output_id IN (${marks})`,
      base.map(item => item.id))).map(row => row.output_id)) : new Set<string>();
  const built = membership(base.filter(item => !replacedStatements.has(item.id)), checked.candidate, replaces, new Set());
  const whole = await validateMembers(db, stored, built.all, { added: new Set(checked.candidate.map(item => item.id)),
    approved: scope.kind === 'incorporate_statement' ? scope.decision_refs.find(ref => ref.kind === 'statement') ?? null : null,
    lifted: new Set(liftedBy(scope)) });
  const problems = [...new Set([...checked.problems, ...built.problems, ...whole.problems])];
  const report = { ...checked.report, base_release_id: current.current_release_id, members: built.ids.length, dropped: built.dropped,
    notes: whole.notes, problems };
  const quality = checked.receipt && !checked.problems.some(text => text.includes('quality receipt'))
    ? `${checked.receipt.artifact_id}@${checked.receipt.sha256}` : null;
  if (problems.length) return block(db, task, outcome, problems, report, quality);
  const scopeRef = `sha256:${await sha256(canonicalJson(report))}`;
  const coverage = `sha256:${await sha256(canonicalJson(checked.coverage.map(row => [row.output_id, row.capability, row.state]).sort()))}`;
  return promote(db, task, { members: built.ids, manifest: recipe.manifest_revision!, recipe: recipe.revision,
    quality: quality!, scope: scopeRef, coverage, base: current.current_release_id, exclusions },
  { ...outcome, checks: { ...outcome.checks, quality: 'passed' }, scope_report: report });
}

/** Validate a saved release whole, as for selection. */
export async function validateRelease(db: D1Database, stored: Stored, releaseId: string): Promise<Check> {
  const release = await db.prepare('SELECT id FROM releases WHERE id = ?').bind(releaseId).first();
  if (!release) return { problems: [`release ${releaseId} is not saved`], notes: [] };
  const items = await members(db, releaseId);
  const listed = (await db.prepare('SELECT COUNT(*) AS total FROM release_outputs WHERE release_id = ?').bind(releaseId).first<{ total: number }>())!.total;
  const check = await validateMembers(db, stored, items);
  if (listed !== items.length) check.problems.unshift(`release ${releaseId} lists ${listed - items.length} output(s) that are not saved`);
  return check;
}

/** Block every restored open task. A task whose revision moves is read again; one that cannot be
 *  blocked is reported, and the restore validation then does not pass. */
async function blockRestored(db: D1Database, taskId: string): Promise<{ blocked: string[]; failed: string[] }> {
  const blocked: string[] = [];
  const failed: string[] = [];
  const note = `Blocked by restore validation in ${taskId}; check the restored state, then resume.`;
  const open = (await db.prepare(`SELECT id FROM maintenance_tasks WHERE id <> ? AND state IN ('queued','running','checked')`)
    .bind(taskId).all<{ id: string }>()).results;
  for (const { id } of open) {
    let done = false;
    for (let attempt = 0; attempt < BLOCK_TRIES && !done; attempt++) {
      const row = await db.prepare('SELECT revision, state FROM maintenance_tasks WHERE id = ?').bind(id).first<{ revision: number; state: string }>();
      if (!row || !['queued', 'running', 'checked'].includes(row.state)) { done = true; break; }  // Paused, blocked or finished: nothing restarts.
      const changed = await db.prepare(`UPDATE maintenance_tasks SET state = 'blocked', revision = revision + 1,
          outcome_json = json_set(outcome_json, '$.limitations', json_insert(json_extract(outcome_json, '$.limitations'), '$[#]', ?))
        WHERE id = ? AND revision = ? AND state IN ('queued','running','checked')`).bind(note, id, row.revision).run();
      if (changed.meta.changes) { blocked.push(id); done = true; }
    }
    if (!done) failed.push(id);
  }
  return { blocked, failed };
}

/** Remove, rollback and restore validation: no preparation, the same checks and gate. */
export async function selectDirect(db: D1Database, objects: ObjectStore | null, task: TaskRow): Promise<SelectResult> {
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  const exclusions = await exclusionState(db);   // Read first: every change below requires it unchanged.
  const current = await selection(db);
  const unchanged = (limitation: string, extra: Partial<Outcome> = {}) => complete(db, task, outcome, {
    ...extra, limitations: [...(extra.limitations ?? outcome.limitations), limitation],
    selection: { current_release_id: current.current_release_id, became_current: false } }, exclusions, current.current_release_id);

  if (scope.kind === 'remove') {
    // The owner's exclusions are recorded even when the current release holds none of the sources,
    // so a later rollback or task cannot bring them back.
    const removes = new Set(scope.inputs.filter(ref => ref.kind === 'source_revision').map(ref => ref.id));
    const adding = new Set(recordedBy(scope).map(ref => ref.subject!));
    const base = await members(db, current.current_release_id);
    const built = membership(base, [], new Set(), removes);
    // What stays selected must not fall under the exclusions this removal records (a subject
    // may be an ancestor or component of another revision).
    const whole = await validateMembers(db, await storedSizes(objects), built.all, { adding });
    const problems = [...built.problems, ...whole.problems];
    if (problems.length) return block(db, task, outcome, problems);
    if (!built.dropped.length) return unchanged(current.current_release_id ? 'The current release holds none of the named sources.'
      : 'Nothing is current, so nothing was removed.');
    const report = { task_id: task.id, task_revision: task.revision, removed: built.dropped, members: built.ids.length,
      base_release_id: current.current_release_id };
    const digest = `sha256:${await sha256(canonicalJson(report))}`;
    const prior = await db.prepare('SELECT manifest_revision, recipe_revision, coverage_basis FROM releases WHERE id = ?')
      .bind(current.current_release_id).first<{ manifest_revision: string; recipe_revision: string; coverage_basis: string }>();
    return promote(db, task, { members: built.ids, manifest: prior!.manifest_revision, recipe: prior!.recipe_revision,
      quality: `control-removal:${digest}`, scope: digest, coverage: prior!.coverage_basis, base: current.current_release_id, exclusions },
    { ...outcome, removal_report: report });
  }

  const stored = await storedSizes(objects);
  if (scope.kind === 'rollback') {
    if (!current.previous_release_id) return unchanged('No previous release is available; the current release is unchanged.');
    const check = await validateRelease(db, stored, current.previous_release_id);
    if (check.problems.length) return unchanged('The previous release is not eligible; the current release is unchanged.',
      { limitations: [...outcome.limitations, ...check.problems.slice(0, 20)] });
    return swap(db, task, outcome, current.current_release_id!, current.previous_release_id, check, exclusions);
  }

  // validate_restore: check the restored releases, and block restored open work so it never restarts by itself.
  const results: Record<string, Check> = {};
  for (const id of [current.current_release_id, current.previous_release_id].filter((value): value is string => !!value))
    results[id] = await validateRelease(db, stored, id);
  const tasks = await blockRestored(db, task.id);
  const problems = [...Object.entries(results).flatMap(([id, check]) => check.problems.map(problem => `${id}: ${problem}`)),
    ...tasks.failed.map(id => `task ${id} kept changing and could not be blocked; check it before resuming work`)];
  const report = { releases: results, blocked_tasks: tasks.blocked, unblocked_tasks: tasks.failed };
  const wanted = typeof scope.constraints.select_release === 'string' ? scope.constraints.select_release : null;
  if (wanted && wanted !== current.current_release_id) {
    const check = await validateRelease(db, stored, wanted);
    const refused = [...check.problems, ...tasks.failed.map(id => `task ${id} could not be blocked`)];
    if (refused.length) return unchanged(`Release ${wanted} is not eligible; the current release is unchanged.`,
      { restore_report: report, limitations: [...outcome.limitations, ...refused.slice(0, 20)] });
    return swap(db, task, { ...outcome, restore_report: report }, current.current_release_id, wanted, check, exclusions);
  }
  return unchanged(problems.length ? 'The restored state did not pass validation; see the limitations.' : 'The restored releases passed validation.',
    { restore_report: report, limitations: [...outcome.limitations, ...problems.slice(0, 20)] });
}

/** Select an existing, validated release; the previously current one becomes previous. */
async function swap(db: D1Database, task: TaskRow, outcome: Outcome, base: string | null, target: string, check: Check, exclusions: string): Promise<SelectResult> {
  const done: Outcome = { ...outcome, limitations: [...outcome.limitations, ...check.notes],
    selection: { current_release_id: target, became_current: true } };
  try {
    await db.batch([
      db.prepare(`UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = ?
        WHERE singleton_id = 1 AND current_release_id IS ? AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ?
          AND state IN ('queued','running')) AND ${EXCLUSION_STATE} = ?`)
        .bind(target, base, task.id, task.revision, exclusions),
      db.prepare(`UPDATE maintenance_tasks SET state = 'completed', revision = revision + 1, base_release_id = ?, candidate_release_id = ?,
          outcome_json = ? WHERE id = ? AND revision = ? AND (SELECT current_release_id FROM release_selection WHERE singleton_id = 1) = ?`)
        .bind(base, target, canonicalJson(done), task.id, task.revision, target),
    ]);
  } catch { /* A lost response: the read below decides. */ }
  const now = await db.prepare('SELECT state FROM maintenance_tasks WHERE id = ?').bind(task.id).first<{ state: string }>();
  return { state: now?.state ?? 'unknown', ...(now?.state === 'completed' ? {} : { limitation: 'The selection or exclusions changed during the check; check the task again.' }) };
}
