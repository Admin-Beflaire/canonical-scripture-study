/** Build tasks driven end to end against synthetic saved records: shared by the selection and
 *  replacement tests. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {localD1} from './d1.ts';
import {fakeGitHub} from './github.ts';
import {GitHubActions} from '../../services/maintenance/control/src/github.ts';
import {jobRoutes} from '../../services/maintenance/control/src/jobs.ts';
import {advance} from '../../services/maintenance/control/src/progress.ts';
import type {ObjectStore} from '../../services/maintenance/control/src/selection.ts';
import {
  requestTask,
  taskReport,
  type TaskRequest,
} from '../../services/maintenance/control/src/tasks.ts';
import type {JobInput} from '../../services/maintenance/control/src/contracts.ts';

export const owner = 'owner@example.invalid';
export const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
export const C = 'synthetic-verses/1';

export function recipeFor(id: string, units: string[][]) {
  const all = units.flat();
  return {
    recipe_version: 'preparation-recipe/1',
    id,
    revision: `${id}/r1`,
    manifest_revision: 'manifest-1',
    adapter: {name: 'synthetic-text', method_version: '1'},
    input_format: 'synthetic/plain',
    parameters: {},
    native_extent: {book: id},
    capabilities: ['source_context', 'word_exact'],
    dependencies: [],
    units: [
      ...units.map((group, index) => ({
        unit_id: `prepare-${index + 1}`,
        kind: 'prepare',
        native_extent: {coordinate_version: C, unit_ids: group},
        depends_on: [],
      })),
      {
        unit_id: 'quality',
        kind: 'quality',
        native_extent: {coordinate_version: C, unit_ids: all},
        depends_on: units.map((_, index) => `prepare-${index + 1}`),
        required_capabilities: ['source_context', 'word_exact'],
      },
    ],
  };
}

/** In-memory private bucket, listed two keys per page to exercise paging. */
function bucket() {
  const sizes = new Map<string, number>();
  const store: ObjectStore & {sizes: Map<string, number>} = {
    sizes,
    async list(prefix, cursor) {
      const keys = [...sizes.keys()]
        .filter(key => key.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + 2);
      return {
        objects: page.map(key => ({key, size: sizes.get(key)!})),
        ...(start + 2 < keys.length ? {cursor: String(start + 2)} : {}),
      };
    },
  };
  return store;
}

const twoRecipes = () => ({
  'collection/recipes/gen.json': recipeFor('gen', [
    ['Gen.1.1', 'Gen.1.2'],
    ['Gen.1.3'],
  ]),
  'collection/recipes/exo.json': recipeFor('exo', [['Exo.1.1']]),
});

export function world(recipes: Record<string, unknown> = twoRecipes()) {
  const db = localD1();
  const objects = bucket();
  const gh = fakeGitHub({recipes});
  const github = new GitHubActions(
    {repository: 'owner/app', token: 'synthetic-token'},
    gh.fetcher,
  );
  const routes = jobRoutes(db, github, objects);
  const post = async (path: string, body: unknown) => {
    const response = await routes(
      new Request(`https://control.example.invalid${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    return (await response.json()) as Record<string, unknown>;
  };
  source(db, 'rev-1');
  return {db, objects, gh, github, post};
}
export type World = ReturnType<typeof world>;

export function source(db: World['db'], revision: string, eligible = 1) {
  const insert = db.sqlite.prepare(
    'INSERT OR IGNORE INTO source_nodes VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    `${revision}:work`,
    'work',
    null,
    'Synthetic work',
    'Synthetic attribution',
    'synthetic',
    '{}',
  );
  insert.run(
    `${revision}:edition`,
    'edition',
    `${revision}:work`,
    'Synthetic edition',
    'Synthetic attribution',
    'synthetic',
    '{}',
  );
  insert.run(
    `${revision}:repr`,
    'representation',
    `${revision}:edition`,
    'Synthetic text',
    'Synthetic attribution',
    'synthetic',
    '{}',
  );
  insert.run(
    revision,
    'source_revision',
    `${revision}:repr`,
    'Synthetic revision',
    'Synthetic attribution',
    'synthetic',
    '{}',
  );
  db.sqlite
    .prepare(
      `INSERT OR IGNORE INTO admissions VALUES (?, ?, 'component-1', 'synthetic terms', '[]', '[]', '[]', ?, 'not_allowed')`,
    )
    .run(`${revision}:component-1`, revision, eligible);
}

/** What Preparation saves for one prepare unit: an evidence output with a body artifact in the
 *  bucket, and an index output depending on it, with available coverage. */
/** The coordinates and capabilities a recipe's prepare units save. */
type Shape = {coordinate: string; capabilities: string[]};
const SYNTHETIC: Shape = {
  coordinate: C,
  capabilities: ['source_context', 'word_exact'],
};
export type Damage = {
  format?: string;
  skipWordCoverage?: string;
  noManifest?: boolean;
  noDirectory?: boolean;
};
export function savePrepared(
  w: World,
  revision: string,
  unit: string,
  units: string[],
  tag = '',
  damage: Damage = {},
  shape: Shape = SYNTHETIC,
) {
  const extent = JSON.stringify({
    coordinate_version: shape.coordinate,
    unit_ids: units,
  });
  // Coverage rows list their units only; the coordinates are the output's.
  const covered = JSON.stringify({unit_ids: units});
  const evidence = `evidence:${sha(revision + unit + tag).slice(0, 32)}`;
  const index = `source_search:${sha(revision + unit + tag + 'i').slice(0, 32)}`;
  const insert = w.db.sqlite.prepare(
    'INSERT INTO prepared_outputs VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    evidence,
    'evidence',
    JSON.stringify([revision]),
    'm1',
    '{}',
    extent,
    JSON.stringify({reuse_basis: 'x', dependencies: []}),
  );
  insert.run(
    index,
    'source_search',
    JSON.stringify([revision]),
    'm1',
    '{}',
    extent,
    JSON.stringify({reuse_basis: 'y', dependencies: [evidence]}),
  );
  const refs = [];
  for (const [output, format, name] of [
    [evidence, 'text/utf-8', 'body'],
    [index, damage.format ?? 'application/x-ndjson', 'postings'],
    ...(damage.noDirectory
      ? []
      : [
          [index, 'application/x-ndjson; profile=index-directory', 'directory'],
        ]),
    ...(damage.noManifest ? [] : [[index, 'application/json', 'manifest']]),
  ]) {
    const digest = sha(output + name);
    const locator = `prepared/${digest}/file`;
    w.db.sqlite
      .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, 10, ?, ?)')
      .run(
        `artifact-${output}-${name}`,
        revision,
        output,
        digest,
        format,
        locator,
      );
    w.objects.sizes.set(locator, 10);
    refs.push({
      artifact_id: `artifact-${output}-${name}`,
      sha256: digest,
      byte_count: 10,
    });
  }
  const coverage = w.db.sqlite.prepare(
    `INSERT INTO coverage VALUES (?, ?, ?, ?, 'available', 'm1', NULL, '[]', NULL)`,
  );
  coverage.run(evidence, revision, covered, 'source_context');
  if (!units.includes(damage.skipWordCoverage ?? ''))
    for (const capability of shape.capabilities.filter(
      item => item !== 'source_context',
    ))
      coverage.run(index, revision, covered, capability);
  return {outputs: [evidence, index], refs};
}

export function prepareTask(
  book: 'gen' | 'exo',
  key: string,
  extra: Partial<TaskRequest> = {},
): TaskRequest {
  return {
    request_key: key,
    instruction: `Load ${book}`,
    steps: ['build'],
    inputs: [{kind: 'source_revision', id: 'rev-1'}],
    extent: {book},
    capabilities: ['source_context', 'word_exact'],
    constraints: {recipe: book},
    ...extra,
  };
}

export function latestRun(w: World, unit: string, taskId: string) {
  const runs = [...w.gh.runs.values()].filter(run => {
    const job = JSON.parse(run.job) as JobInput;
    return job.unit_id === unit && job.task_id === taskId;
  });
  const run = runs[runs.length - 1];
  return {run, job: JSON.parse(run.job) as JobInput, text: run.job};
}

export async function report(
  w: World,
  taskId: string,
  unit: string,
  overrides: Record<string, unknown> = {},
) {
  const {run, job, text} = latestRun(w, unit, taskId);
  await w.post('/internal/jobs/state', {
    task_id: taskId,
    unit_id: unit,
    attempt: job.attempt,
    run_id: String(run.id),
    job_input_basis: sha(text),
  });
  const result = {
    contract_version: 'maintenance-job/1',
    task_id: taskId,
    task_revision: job.task_revision,
    unit_id: unit,
    attempt: job.attempt,
    basis_digest: job.basis_digest,
    run_id: String(run.id),
    completed_extent: job.native_extent,
    remaining_extent: {},
    output_refs: [],
    coverage_refs: [],
    quality_receipt_ref: null,
    state: 'succeeded',
    diagnostics: [],
    ...overrides,
  };
  const reply = await w.post('/internal/jobs/result', {
    result,
    commit: w.gh.commit,
  });
  run.status = 'completed';
  return reply;
}

/** Run a whole book task: acquire, prepare units (saving their records), quality with a receipt. */
export async function runBook(
  w: World,
  request: TaskRequest,
  revision = 'rev-1',
  options: {
    tag?: string;
    beforeQuality?: () => void;
    damage?: Damage;
    release?: boolean;
  } = {},
) {
  const created = await requestTask(w.db, owner, request);
  assert.equal(created.status, 'created', JSON.stringify(created));
  const taskId = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, taskId, w.objects);
  const recipe = JSON.parse(
    await (await w.github.readFile(
      `collection/recipes/${(request.constraints as {recipe: string}).recipe}.json`,
    ))!,
  ) as ReturnType<typeof recipeFor>;
  const refs = [];
  for (const unit of recipe.units.filter(item => item.kind === 'prepare')) {
    const saved = savePrepared(
      w,
      revision,
      unit.unit_id + (request.constraints as {recipe: string}).recipe,
      unit.native_extent.unit_ids as string[],
      options.tag,
      options.damage,
      {
        coordinate: unit.native_extent.coordinate_version as string,
        capabilities: recipe.capabilities,
      },
    );
    refs.push(...saved.refs);
    await report(w, taskId, unit.unit_id, {output_refs: saved.refs});
  }
  options.beforeQuality?.();
  await report(w, taskId, 'quality', {
    output_refs: refs,
    quality_receipt_ref: receipt(w, taskId),
  });
  const built = (await taskReport(w.db, owner, taskId))!;
  if (
    options.release === false ||
    built.state !== 'checked' ||
    !request.steps.includes('build')
  )
    return {taskId, task: built};
  // A build ends with a checked candidate; a separate release task makes it current.
  const released = await releaseBuild(
    w,
    taskId,
    `release-${request.request_key}`,
  );
  return {taskId, releaseId: released.id, task: released.report};
}

export async function releaseBuild(w: World, buildId: string, key: string) {
  const created = await requestTask(w.db, owner, {
    request_key: key,
    instruction: `Release ${buildId}`,
    steps: ['select'],
    constraints: {candidate: buildId},
  });
  assert.equal(created.status, 'created', JSON.stringify(created));
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  return {id, report: (await taskReport(w.db, owner, id))!};
}

export const selected = (w: World) =>
  ({
    ...w.db.sqlite
      .prepare(
        'SELECT current_release_id, previous_release_id FROM release_selection',
      )
      .get(),
  }) as {current_release_id: string | null; previous_release_id: string | null};
/** A quality receipt reference, with the receipt stored where Preparation saves it. */
export function receipt(w: World, taskId: string) {
  const digest = sha(`receipt ${taskId}`);
  w.objects.sizes.set(`prepared/receipts/${digest}.json`, 99);
  return {
    artifact_id: `receipt:${digest.slice(0, 32)}`,
    sha256: digest,
    byte_count: 99,
  };
}
export const membersOf = (w: World, release: string | null) =>
  (
    w.db.sqlite
      .prepare(
        'SELECT output_id FROM release_outputs WHERE release_id = ? ORDER BY output_id',
      )
      .all(release) as Array<{output_id: string}>
  ).map(row => row.output_id);

/** Request a rollback, advance it, and return its task ID. */
export async function rollBack(w: ReturnType<typeof world>, key = 'rb1') {
  const created = await requestTask(w.db, owner, {
    request_key: key,
    instruction: 'Roll back',
    steps: ['rollback'],
  });
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  return id;
}
