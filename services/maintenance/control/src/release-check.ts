import {type D1Database} from './d1.ts';
import type {DecisionRef} from './tasks.ts';
import readerCatalogue from '../../../../schemas/reader-references/nrsva-1.json' with {type: 'json'};

/** Checks of a whole release (Maintenance Control To-Be §4, MC-03): saved outputs, dependency
 *  closure, stored artifacts with recorded sizes and supported formats, admission for both hosts,
 *  active exclusions and statements. Nothing here writes. */

/** Control's view of the private bucket: object sizes by key prefix, in pages. */
export interface ObjectStore {
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{objects: Array<{key: string; size: number}>; cursor?: string}>;
  /** Remove stored objects (release cleanup only); a missing key is not an error. */
  remove?(keys: string[]): Promise<void>;
}

/** Stored artifact formats a release may hold; index-manifest/2 adds the paged directory. */
export const FORMATS = new Set([
  'text/utf-8',
  'application/x-ndjson',
  'application/json',
  'application/x-ndjson; profile=index-directory',
  'application/x-ndjson; profile=aid-entries',
]);
/** Data format versions of a release, as `infrastructure/github/deployment/compatibility.json`
 *  lists them: deployment refuses code that does not support the selected release's versions. */
export const SCHEMA_VERSIONS = {
  evidence_records: '1',
  native_reference: '1',
  index_manifest: '2',
};
/** Formats the deployed Study can read, as `compatibility.json` lists them (a test keeps them equal).
 *  Rollback and restore select only releases whose every recorded format is listed here; when a
 *  format changes, this list changes with the reader and the check follows. */
export const READABLE_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  evidence_records: ['1'],
  native_reference: ['1'],
  index_manifest: ['2'],
  reader_scheme_version: [readerCatalogue.reader_scheme_version],
};
const MAX_LIST_PAGES = 100; // At most 100,000 stored objects checked in one request.
const CHUNK = 50; // D1 binds at most 100 parameters per statement.
const DIRECTORY = 'application/x-ndjson; profile=index-directory';
/** Files every index output needs, in any format version: postings and manifest. */
const INDEX_FILES: Record<string, string[]> = {
  source_search: ['application/x-ndjson', 'application/json'],
  word_index: ['application/x-ndjson', 'application/json'],
};
/** A task's new index outputs use index-manifest/2, which adds the paged directory. Kept members
 *  were approved in an earlier release; they are checked for presence and integrity, not
 *  re-judged by a newer format rule. Each source's index is read on its own. */
const NEW_INDEX_FILES = [DIRECTORY];

interface OutputRow {
  id: string;
  kind: string;
  input_revisions_json: string;
  native_extent_json: string;
  validation_basis_json: string;
}
export interface Output {
  id: string;
  kind: string;
  revisions: string[];
  extent: Record<string, unknown>;
  dependencies: string[];
}
export interface ArtifactRow {
  id: string;
  output_id: string | null;
  sha256: string;
  byte_count: number;
  format: string;
  registered_locator: string;
}
export type Check = {problems: string[]; notes: string[]};
/** Stored object sizes, or why they could not be read. */
export type Stored = Map<string, number> | 'no_binding' | 'too_many';

const parseOutput = (row: OutputRow): Output => ({
  id: row.id,
  kind: row.kind,
  revisions: JSON.parse(row.input_revisions_json) as string[],
  extent: JSON.parse(row.native_extent_json) as Record<string, unknown>,
  dependencies:
    (JSON.parse(row.validation_basis_json) as {dependencies?: string[]})
      .dependencies ?? [],
});
const hasReaderMappings = (items: Output[]) =>
  items.some(item => item.kind === 'reader_reference');
export const releaseVersions = (items: Output[]) =>
  hasReaderMappings(items)
    ? {
        ...SCHEMA_VERSIONS,
        reader_scheme_version: readerCatalogue.reader_scheme_version,
      }
    : SCHEMA_VERSIONS;

export async function inChunks<T>(
  db: D1Database,
  sql: (marks: string) => string,
  ids: string[],
): Promise<T[]> {
  const rows: T[] = [];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK);
    rows.push(
      ...(
        await db
          .prepare(sql(chunk.map(() => '?').join(',')))
          .bind(...chunk)
          .all<T>()
      ).results,
    );
  }
  return rows;
}

export async function outputs(
  db: D1Database,
  ids: string[],
): Promise<Output[]> {
  return (
    await inChunks<OutputRow>(
      db,
      marks => `SELECT id, kind, input_revisions_json, native_extent_json, validation_basis_json
    FROM prepared_outputs WHERE id IN (${marks})`,
      ids,
    )
  ).map(parseOutput);
}

export async function members(
  db: D1Database,
  releaseId: string | null,
): Promise<Output[]> {
  if (!releaseId) return [];
  return (
    await db
      .prepare(
        `SELECT po.id, po.kind, po.input_revisions_json, po.native_extent_json, po.validation_basis_json
    FROM release_outputs ro JOIN prepared_outputs po ON po.id = ro.output_id WHERE ro.release_id = ?`,
      )
      .bind(releaseId)
      .all<OutputRow>()
  ).results.map(parseOutput);
}

export async function selection(db: D1Database) {
  return (await db
    .prepare(
      'SELECT current_release_id, previous_release_id FROM release_selection WHERE singleton_id = 1',
    )
    .first<{
      current_release_id: string | null;
      previous_release_id: string | null;
    }>())!;
}

/** Every stored object under `prepared/` (outputs and receipts), by key. */
export async function storedSizes(
  objects: ObjectStore | null,
): Promise<Stored> {
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
export const storageProblem = (stored: Stored) =>
  stored === 'no_binding'
    ? 'stored objects cannot be checked: Control has no bucket binding'
    : stored === 'too_many'
      ? 'too many stored objects to check in one request'
      : null;

export interface MemberOptions {
  approved?: DecisionRef | null;
  added?: Set<string>;
  lifted?: Set<string>;
  adding?: Set<string>;
  allCurrentFormat?: boolean;
}
/** A check plus the ids an exclusion could match: every member source revision, its ancestors
 *  and its admitted components. The write guard tests exactly these ids at write time. */
export type Validation = Check & {related: string[]};
interface StatementRow {
  output_id: string;
  name: string;
  version: string;
  status: string;
}

/** Everything a release needs, checked over its whole membership. Promotion, removal, rollback
 *  and restore all use it. */
export async function validateMembers(
  db: D1Database,
  stored: Stored,
  items: Output[],
  options: MemberOptions = {},
): Promise<Validation> {
  const ids = items.map(item => item.id);
  const artifacts = await inChunks<ArtifactRow>(
    db,
    marks => `SELECT id, output_id, sha256, byte_count, format, registered_locator
    FROM artifacts WHERE output_id IN (${marks})`,
    ids,
  );
  const statements = await inChunks<StatementRow>(
    db,
    marks =>
      `SELECT output_id, name, version, status FROM character_statements WHERE output_id IN (${marks})`,
    ids,
  );
  const sources = await sourceChecks(
    db,
    items,
    new Set(statements.map(row => row.output_id)),
  );
  const exclusions = await exclusionChecks(db, sources.revisions, options);
  return {
    problems: [
      ...(await savedAndClosed(db, items)),
      ...indexProblems(items, artifacts, options),
      ...artifactProblems(artifacts, stored),
      ...statementProblems(statements, options),
      ...sources.problems,
      ...exclusions.problems,
    ],
    notes: sources.notes,
    related: exclusions.related,
  };
}

async function savedAndClosed(db: D1Database, items: Output[]) {
  const problems: string[] = [];
  const ids = items.map(item => item.id);
  const found = new Set((await outputs(db, ids)).map(item => item.id));
  for (const id of ids)
    if (!found.has(id)) problems.push(`output ${id} is not saved`);
  const memberIds = new Set(ids);
  for (const item of items)
    for (const dependency of item.dependencies)
      if (!memberIds.has(dependency))
        problems.push(
          `output ${item.id} depends on ${dependency}, which is not in the release`,
        );
  return problems;
}

/** Index outputs live only in their stored files: each needs its postings and its manifest.
 *  Evidence may keep its wording in D1, so it needs no artifact. */
function indexProblems(
  items: Output[],
  artifacts: ArtifactRow[],
  options: MemberOptions,
) {
  const problems: string[] = [];
  for (const item of items.filter(output => INDEX_FILES[output.kind])) {
    const formats = new Set(
      artifacts
        .filter(artifact => artifact.output_id === item.id)
        .map(artifact => artifact.format),
    );
    const current = options.allCurrentFormat || options.added?.has(item.id);
    const required = current
      ? [...INDEX_FILES[item.kind], ...NEW_INDEX_FILES]
      : INDEX_FILES[item.kind];
    for (const format of required)
      if (!formats.has(format))
        problems.push(`index output ${item.id} has no ${format} file`);
  }
  return problems;
}

function artifactProblems(artifacts: ArtifactRow[], stored: Stored) {
  const problems: string[] = [];
  for (const artifact of artifacts)
    if (!FORMATS.has(artifact.format))
      problems.push(
        `artifact ${artifact.id} has unsupported format ${artifact.format}`,
      );
  if (!artifacts.length) return problems;
  const problem = storageProblem(stored);
  if (problem) return [...problems, problem];
  for (const artifact of artifacts) {
    const size = (stored as Map<string, number>).get(
      artifact.registered_locator,
    );
    if (size === undefined)
      problems.push(`artifact ${artifact.id} is missing from storage`);
    else if (size !== artifact.byte_count)
      problems.push(
        `artifact ${artifact.id} has ${size} bytes, ${artifact.byte_count} recorded`,
      );
  }
  return problems;
}

function statementProblems(statements: StatementRow[], options: MemberOptions) {
  const problems: string[] = [];
  if (statements.length > 1)
    problems.push('more than one character-of-God statement would be selected');
  for (const statement of statements) {
    const name = `${statement.name} ${statement.version}`;
    if (statement.status !== 'approved')
      problems.push(`statement ${name} is not approved`);
    // A statement this task adds must be exactly the owner's approved name and version.
    else if (
      options.added?.has(statement.output_id) &&
      (!options.approved ||
        options.approved.name !== statement.name ||
        options.approved.version !== statement.version)
    )
      problems.push(
        `statement ${name} is not the owner-approved version for this task`,
      );
  }
  return problems;
}

/** Every input revision that is a source revision must be saved and admitted for both hosts. */
async function sourceChecks(
  db: D1Database,
  items: Output[],
  statementIds: Set<string>,
) {
  const problems: string[] = [];
  const revisions = [...new Set(items.flatMap(item => item.revisions))];
  const nodes = new Map(
    (
      await inChunks<{id: string; kind: string}>(
        db,
        marks => `SELECT id, kind FROM source_nodes WHERE id IN (${marks})`,
        revisions,
      )
    ).map(row => [row.id, row.kind]),
  );
  for (const item of items)
    if (
      !statementIds.has(item.id) &&
      nodes.get(item.revisions[0]) !== 'source_revision'
    )
      problems.push(
        `output ${item.id} has no saved source revision ${item.revisions[0]}`,
      );
  const sourceRevisions = revisions.filter(
    id => nodes.get(id) === 'source_revision',
  );
  const admitted = new Map(
    (
      await inChunks<{
        source_revision_id: string;
        total: number;
        eligible: number;
      }>(
        db,
        marks =>
          `SELECT source_revision_id, COUNT(*) AS total, SUM(both_hosts_eligible = 1) AS eligible FROM admissions
     WHERE source_revision_id IN (${marks}) GROUP BY source_revision_id`,
        sourceRevisions,
      )
    ).map(row => [row.source_revision_id, row]),
  );
  for (const id of sourceRevisions) {
    const row = admitted.get(id);
    if (!row || row.total === 0 || row.eligible !== row.total)
      problems.push(`source revision ${id} is not admitted for both hosts`);
  }
  const other = revisions.filter(id => !nodes.has(id));
  const notes = other.length
    ? [
        `analysis revisions attributed by the reviewed recipe: ${other.slice(0, 5).join(', ')}${other.length > 5 ? ', …' : ''}`,
      ]
    : [];
  return {problems, notes, revisions: sourceRevisions};
}

/** For each source revision: itself, its ancestors and its admitted components. */
async function relatedIds(db: D1Database, revisions: string[]) {
  const related = new Map(revisions.map(id => [id, new Set<string>([id])]));
  const ancestors = await inChunks<{rev: string; id: string}>(
    db,
    marks => `WITH RECURSIVE up(rev, id, parent) AS (SELECT id, id, parent_id FROM source_nodes WHERE id IN (${marks})
      UNION SELECT up.rev, s.id, s.parent_id FROM source_nodes s JOIN up ON s.id = up.parent)
    SELECT rev, id FROM up`,
    revisions,
  );
  const components = await inChunks<{rev: string; id: string}>(
    db,
    marks =>
      `SELECT source_revision_id AS rev, component AS id FROM admissions WHERE source_revision_id IN (${marks})`,
    revisions,
  );
  for (const row of [...ancestors, ...components])
    related.get(row.rev)?.add(row.id);
  return related;
}

/** Active exclusions apply to a source revision, any of its ancestors or an admitted component.
 *  An owner exclusion decision on a task that adds data lifts that exclusion. */
async function exclusionChecks(
  db: D1Database,
  revisions: string[],
  options: MemberOptions,
) {
  const related = await relatedIds(db, revisions);
  const active = (
    await db
      .prepare(
        'SELECT source_or_component_id FROM maintenance_exclusions WHERE active = 1',
      )
      .all<{source_or_component_id: string}>()
  ).results
    .map(row => row.source_or_component_id)
    .filter(id => !options.lifted?.has(id));
  const excluded = new Set([...active, ...(options.adding ?? [])]);
  const problems: string[] = [];
  for (const [revision, ids] of related) {
    const hit = [...ids].find(id => excluded.has(id));
    if (hit)
      problems.push(
        `source revision ${revision} is excluded by the owner (${hit})`,
      );
  }
  return {
    problems,
    related: [...new Set([...related.values()].flatMap(ids => [...ids]))],
  };
}

/** Validate a saved release whole before selecting it again (rollback, restore). The deployed
 *  Study reader must be able to read it: it must record the current index format, and every
 *  index must be complete in that format. */
export async function validateRelease(
  db: D1Database,
  stored: Stored,
  releaseId: string,
): Promise<Validation> {
  const release = await db
    .prepare('SELECT id, schema_versions_json FROM releases WHERE id = ?')
    .bind(releaseId)
    .first<{id: string; schema_versions_json: string}>();
  if (!release)
    return {
      problems: [`release ${releaseId} is not saved`],
      notes: [],
      related: [],
    };
  const items = await members(db, releaseId);
  const listed = (await db
    .prepare(
      'SELECT COUNT(*) AS total FROM release_outputs WHERE release_id = ?',
    )
    .bind(releaseId)
    .first<{total: number}>())!.total;
  const check = await validateMembers(db, stored, items, {
    allCurrentFormat: true,
  });
  if (listed !== items.length)
    check.problems.unshift(
      `release ${releaseId} lists ${listed - items.length} output(s) that are not saved`,
    );
  // Cleanup removes the membership of a release nothing needs; an empty release cannot be selected again.
  if (!listed)
    check.problems.unshift(
      `release ${releaseId} has no members; its membership was removed`,
    );
  check.problems.unshift(
    ...unreadable(
      releaseId,
      release.schema_versions_json,
      hasReaderMappings(items),
    ),
  );
  return check;
}

/** Why the deployed Study could not read a release with these recorded formats (empty if it can). */
export function unreadable(
  releaseId: string,
  recordedJson: string,
  needsReaderScheme = false,
): string[] {
  let recorded: unknown;
  try {
    recorded = JSON.parse(recordedJson);
  } catch {
    recorded = undefined;
  }
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded))
    return [`release ${releaseId} has no readable format record`];
  const versions = recorded as Record<string, unknown>;
  const problems: string[] = [];
  for (const [name, supported] of Object.entries(READABLE_VERSIONS)) {
    if (
      name === 'reader_scheme_version' &&
      versions[name] === undefined &&
      !needsReaderScheme
    )
      continue;
    if (!supported.includes(String(versions[name])))
      problems.push(
        `release ${releaseId} uses ${name} format ${versions[name] === undefined ? '(none)' : String(versions[name])}; the Study reader reads ${supported.join(', ')}`,
      );
  }
  for (const name of Object.keys(versions))
    if (!(name in READABLE_VERSIONS))
      problems.push(
        `release ${releaseId} records ${name}, a format the Study reader does not know`,
      );
  return problems;
}
