import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeGitHub} from './github.ts';
import {GitHubActions} from '../../services/maintenance/control/src/github.ts';
import {advance} from '../../services/maintenance/control/src/progress.ts';
import {
  membership,
  selectDirect,
  validateRelease,
  SCHEMA_VERSIONS,
  READABLE_VERSIONS,
  unreadable,
} from '../../services/maintenance/control/src/selection.ts';
import {SUPPORTED_SCHEMA_VERSIONS} from '../../services/study/src/read/session.ts';
import compatibility from '../../infrastructure/github/deployment/compatibility.json' with {type: 'json'};
import {
  controlTask,
  requestTask,
  taskReport,
  type TaskRequest,
} from '../../services/maintenance/control/src/tasks.ts';
import {
  owner,
  sha,
  C,
  recipeFor,
  world,
  type World,
  type Damage,
  source,
  savePrepared,
  prepareTask,
  report,
  runBook,
  releaseBuild,
  selected,
  receipt,
  membersOf,
  rollBack,
} from './builds.ts';

/** MC-03: scope check, release construction and checked selection. Synthetic records only. */
/** Run `action` once, just before the guarded change of the named task is written to D1.
 *  With `every`, on each write. With `fail`, that write never reaches the database. */
function beforeWrite(
  w: World,
  requestKey: string,
  action: () => unknown = () => {},
  fail = () => false,
  every = false,
) {
  const batch = w.db.batch.bind(w.db);
  let done = false;
  w.db.batch = async statements => {
    const row = w.db.sqlite
      .prepare(
        `SELECT state FROM maintenance_tasks WHERE request_key = ? AND state IN ('queued','running')`,
      )
      .get(requestKey);
    if (row && statements.length >= 3) {
      const first = !done;
      done = true; // before the action: the action may write batches of its own
      if (every || first) await action();
      if (fail()) throw new Error('worker stopped before the write');
    }
    return batch(statements);
  };
  return () => done;
}

/** Two books from two source revisions, both selected. */
async function twoBooks(w: World) {
  source(w.db, 'rev-2');
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(
    w,
    prepareTask('exo', 'e1', {
      inputs: [{kind: 'source_revision', id: 'rev-2'}],
    }),
    'rev-2',
  );
}

/** Exodus is selected; Genesis is built and waits, checked, to be released. Returns its task ID. */
async function stageGenesis(w: World) {
  await runBook(w, prepareTask('exo', 'e1'));
  const staged = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    release: false,
  });
  return staged.taskId;
}

/** A Genesis task with both prepare units reported, waiting for its quality result. */
async function preparedGenesis(w: World) {
  const created = await requestTask(w.db, owner, prepareTask('gen', 'g1'));
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  const refs = [];
  for (const [unit, verses] of [
    ['prepare-1', ['Gen.1.1', 'Gen.1.2']],
    ['prepare-2', ['Gen.1.3']],
  ] as const) {
    const saved = savePrepared(w, 'rev-1', unit, [...verses]);
    refs.push(...saved.refs);
    await report(w, id, unit, {output_refs: saved.refs});
  }
  return {id, refs};
}

/** The task is blocked for the expected reason and nothing was selected. */
function assertBlockedBy(
  w: World,
  task: {state: string; limitations: string[]},
  expected: string,
  name: string,
) {
  assert.equal(task.state, 'blocked', name);
  assert.ok(
    task.limitations.some(text => text.includes(expected)),
    `${name}: ${task.limitations.join(' | ')}`,
  );
  assert.equal(selected(w).current_release_id, null, name);
}

/** The write of the named task never reaches the database while `on` is set. */
function interruptWrite(w: World, requestKey: string) {
  const interrupt = {on: true};
  beforeWrite(
    w,
    requestKey,
    () => {},
    () => interrupt.on,
  );
  return interrupt;
}

const releaseCounts = (w: World) => ({
  ...w.db.sqlite
    .prepare(
      `SELECT (SELECT COUNT(*) FROM releases) AS releases, (SELECT COUNT(*) FROM release_outputs) AS members`,
    )
    .get(),
});

test('a checked candidate becomes current in one guarded selection; the first promotion has no base', async () => {
  const w = world();
  const {task, taskId} = await runBook(w, prepareTask('gen', 'g1'));
  assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  assert.equal(task.checks.quality, 'passed');
  assert.equal(task.checks.scope, 'passed');
  assert.ok(task.checks.scope_receipt?.startsWith('sha256:'));
  assert.equal(task.data_current, true);
  const now = selected(w);
  assert.equal(now.current_release_id, task.selection.candidate_release_id);
  assert.equal(now.previous_release_id, null);
  assert.equal(task.selection.base_release_id, null);
  assert.equal(membersOf(w, now.current_release_id).length, 4);
  const release = w.db.sqlite.prepare('SELECT * FROM releases').get() as Record<
    string,
    string
  >;
  assert.equal(release.recipe_revision, 'gen/r1');
  const digest = sha(`receipt ${taskId}`);
  assert.equal(
    release.quality_receipt,
    `receipt:${digest.slice(0, 32)}@${digest}`,
  );
  // Deployment must accept the selected release: every version it records is one the code supports.
  const versions = JSON.parse(release.schema_versions_json) as Record<
    string,
    string
  >;
  assert.deepEqual(versions, SCHEMA_VERSIONS);
  for (const [key, value] of Object.entries(versions))
    assert.ok(
      (compatibility as Record<string, string[]>)[key]?.includes(value),
      `${key} ${value} is supported by deployment`,
    );
});

/** Save a reader-reference mapping with its manifest artifact and add it to the outputs a release builds. */
function saveReaderMapping(
  w: ReturnType<typeof world>,
  mapping: string,
  version: string,
  units: string[],
  refs: {artifact_id: string; sha256: string; byte_count: number}[],
) {
  const extent = JSON.stringify({coordinate_version: C, unit_ids: units});
  w.db.sqlite
    .prepare('INSERT INTO prepared_outputs VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      mapping,
      'reader_reference',
      '["rev-2"]',
      'm1',
      JSON.stringify({reader_scheme_version: version}),
      extent,
      '{"reuse_basis":"mapping","dependencies":[]}',
    );
  w.db.sqlite
    .prepare('INSERT INTO reader_reference_bases VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      'base:exo',
      mapping,
      'rev-2',
      version,
      C,
      '{"ranges":[{"book_id":"Exod","chapter":1,"first_verse":1,"last_verse":1}]}',
      '{}',
    );
  const digest = sha(mapping);
  const locator = `prepared/${digest}.json`;
  w.db.sqlite
    .prepare(
      "INSERT INTO artifacts VALUES (?, ?, ?, ?, 10, 'application/json', ?)",
    )
    .run('manifest:exo', 'rev-2', mapping, digest, locator);
  w.objects.sizes.set(locator, 10);
  refs.push({artifact_id: 'manifest:exo', sha256: digest, byte_count: 10});
}

test('a release records the catalogue version for reader mappings it adds or keeps', async () => {
  const w = world();
  await runBook(w, prepareTask('gen', 'g1'));
  source(w.db, 'rev-2');
  const created = await requestTask(
    w.db,
    owner,
    prepareTask('exo', 'e1', {
      inputs: [{kind: 'source_revision', id: 'rev-2'}],
    }),
  );
  assert.equal(created.status, 'created');
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);

  const units = ['Exo.1.1'];
  const {refs} = savePrepared(w, 'rev-2', 'prepare-1', units);
  const mapping = 'reader_reference:exo';
  const version = 'nrsva/1';
  saveReaderMapping(w, mapping, version, units, refs);
  await report(w, id, 'prepare-1', {output_refs: refs});
  await report(w, id, 'quality', {
    output_refs: refs,
    quality_receipt_ref: receipt(w, id),
  });
  await releaseBuild(w, id, 'release-mapping');

  const readVersion = () => {
    const row = w.db.sqlite
      .prepare('SELECT schema_versions_json FROM releases WHERE id = ?')
      .get(selected(w).current_release_id) as {schema_versions_json: string};
    return JSON.parse(row.schema_versions_json).reader_scheme_version;
  };
  assert.equal((await taskReport(w.db, owner, id))!.state, 'completed');
  assert.equal(readVersion(), version);
  assert.ok(membersOf(w, selected(w).current_release_id).includes(mapping));

  for (const revision of ['rev-1', 'rev-2']) {
    const remove = await requestTask(w.db, owner, {
      request_key: `remove-${revision}`,
      instruction: 'Remove a source',
      steps: ['remove'],
      inputs: [{kind: 'source_revision', id: revision}],
    });
    const removalId = (remove as {task: {id: string}}).task.id;
    await advance(w.db, w.github, removalId, w.objects);
    assert.equal(
      (await taskReport(w.db, owner, removalId))!.state,
      'completed',
    );
    assert.equal(readVersion(), revision === 'rev-1' ? version : undefined);
  }
});

/** The reader-reference build of a book, run until it waits as a checked candidate. */
async function checkedReaderBuild() {
  const w = world();
  const recipe = recipeFor('exo-reader', [['Exo.1.1']]);
  w.gh.recipes.set('collection/recipes/exo-reader.json', {
    ...recipe,
    native_extent: {book: 'exo'},
    capabilities: ['reader_reference'],
    units: recipe.units.map(unit =>
      unit.kind === 'quality'
        ? {...unit, required_capabilities: ['reader_reference']}
        : unit,
    ),
  });
  source(w.db, 'rev-2');
  const inputs = [{kind: 'source_revision' as const, id: 'rev-2'}];
  const created = await requestTask(
    w.db,
    owner,
    prepareTask('exo', 'reader', {
      inputs,
      capabilities: ['reader_reference'],
      constraints: {recipe: 'exo-reader'},
    }),
  );
  assert.ok(created.status === 'created', JSON.stringify(created));
  const id = created.task.id;
  await advance(w.db, w.github, id, w.objects);
  const refs: {artifact_id: string; sha256: string; byte_count: number}[] = [];
  const mapping = 'reader_reference:exo';
  saveReaderMapping(w, mapping, 'nrsva/1', ['Exo.1.1'], refs);
  w.db.sqlite
    .prepare(
      `INSERT INTO coverage VALUES (?, 'rev-2', ?, 'reader_reference', 'available', 'm1', NULL, '[]', NULL)`,
    )
    .run(
      mapping,
      JSON.stringify({coordinate_version: C, unit_ids: ['Exo.1.1']}),
    );
  await report(w, id, 'prepare-1', {output_refs: refs});
  await report(w, id, 'quality', {
    output_refs: refs,
    quality_receipt_ref: receipt(w, id),
  });
  return {w, id, mapping, inputs};
}

test('the reader-reference and text builds of a book can both be prepared to checked, then be made current in that order', async () => {
  const {w, id, mapping, inputs} = await checkedReaderBuild();
  const text = await runBook(w, prepareTask('exo', 'text', {inputs}), 'rev-2', {
    release: false,
  });
  assert.equal(text.task.state, 'checked', text.task.limitations.join(' | '));
  assert.equal((await taskReport(w.db, owner, id))!.state, 'checked');
  assert.equal(selected(w).current_release_id, null, 'nothing is selected');

  for (const [build, key] of [
    [id, 'release-reader'],
    [text.taskId, 'release-text'],
  ]) {
    const {report} = await releaseBuild(w, build, key);
    assert.equal(report.state, 'completed', report.limitations.join(' | '));
  }
  const members = membersOf(w, selected(w).current_release_id);
  assert.equal(members.length, 3);
  assert.ok(members.includes(mapping));
});

test('a second book is added to the current release; parallel tasks each rebuild from current at check time', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  const second = await runBook(w, prepareTask('exo', 'e1'));
  assert.equal(second.task.state, 'completed');
  const now = selected(w);
  assert.equal(
    now.previous_release_id,
    first.task.selection.candidate_release_id,
  );
  assert.equal(
    second.task.selection.base_release_id,
    first.task.selection.candidate_release_id,
  );
  assert.equal(
    membersOf(w, now.current_release_id).length,
    6,
    'Genesis kept, Exodus added',
  );
});

test('a kept index from an earlier release is not re-judged by the new directory rule', async () => {
  const w = world();
  // Genesis was approved in an earlier release, before indexes had a directory file.
  const old = savePrepared(w, 'rev-1', 'old-gen', ['Gen.1.1'], 'old', {
    noDirectory: true,
  });
  w.db.sqlite.exec(
    `INSERT INTO releases VALUES ('release-old', 'm', 'r', '{}', 'c', 'q', 's')`,
  );
  for (const output of old.outputs)
    w.db.sqlite
      .prepare(`INSERT INTO release_outputs VALUES ('release-old', ?)`)
      .run(output);
  w.db.sqlite.exec(
    `UPDATE release_selection SET current_release_id = 'release-old'`,
  );
  const exodus = await runBook(w, prepareTask('exo', 'e1'));
  assert.equal(
    exodus.task.state,
    'completed',
    exodus.task.limitations.join(' | '),
  );
  const members = membersOf(w, selected(w).current_release_id);
  for (const output of old.outputs)
    assert.ok(members.includes(output), 'old Genesis kept unchanged');
  assert.equal(members.length, old.outputs.length + 2, 'Exodus added');
});

test('R34-1: rollback and restore never select a release the v2 reader cannot read', async () => {
  const w = world();
  await runBook(w, prepareTask('gen', 'g1'));
  const current = selected(w).current_release_id;
  // An earlier release from before index format 2: no recorded index_manifest, no directory file.
  const old = savePrepared(w, 'rev-1', 'old-exo', ['Exo.1.1'], 'old', {
    noDirectory: true,
  });
  w.db.sqlite.exec(
    `INSERT INTO releases VALUES ('release-v1', 'm', 'r', '{"evidence_records":"1","native_reference":"1"}', 'c', 'q', 's')`,
  );
  for (const output of old.outputs)
    w.db.sqlite
      .prepare(`INSERT INTO release_outputs VALUES ('release-v1', ?)`)
      .run(output);
  w.db.sqlite.exec(
    `UPDATE release_selection SET previous_release_id = 'release-v1'`,
  );
  const before = selected(w);
  const rollbackId = await rollBack(w, 'rb-v1');
  const rolled = (await taskReport(w.db, owner, rollbackId))!;
  assert.equal(rolled.data_current, false);
  assert.ok(
    rolled.limitations.some(text =>
      text.includes('uses index_manifest format (none)'),
    ),
    rolled.limitations.join(' | '),
  );
  assert.ok(
    rolled.limitations.some(text =>
      text.includes('profile=index-directory file'),
    ),
    rolled.limitations.join(' | '),
  );
  assert.deepEqual(selected(w), before);
  const restore = await requestTask(w.db, owner, {
    request_key: 'vr-v1',
    instruction: 'Select the old release',
    steps: ['validate_restore'],
    constraints: {select_release: 'release-v1'},
  });
  const restoreId = (restore as {task: {id: string}}).task.id;
  await advance(w.db, w.github, restoreId, w.objects);
  assert.equal((await taskReport(w.db, owner, restoreId))!.data_current, false);
  assert.equal(selected(w).current_release_id, current);
});

test('the rollback readability list is the deployed Study reader list', () => {
  assert.deepEqual(READABLE_VERSIONS, compatibility);
  assert.deepEqual({...READABLE_VERSIONS}, {...SUPPORTED_SCHEMA_VERSIONS});
  assert.deepEqual(
    unreadable('r', JSON.stringify(SCHEMA_VERSIONS)),
    [],
    'what Control writes is readable',
  );
  assert.ok(
    unreadable('r', JSON.stringify(SCHEMA_VERSIONS), true).some(text =>
      text.includes('reader_scheme_version format (none)'),
    ),
  );
  assert.ok(
    unreadable(
      'r',
      JSON.stringify({...SCHEMA_VERSIONS, reader_scheme_version: 'unknown/1'}),
    ).some(text => text.includes('reader_scheme_version format unknown/1')),
  );
  for (const [recorded, expected] of [
    ['not json', 'no readable format record'],
    [
      JSON.stringify({...SCHEMA_VERSIONS, evidence_records: '9'}),
      'evidence_records format 9',
    ],
    [
      JSON.stringify({evidence_records: '1', index_manifest: '2'}),
      'native_reference format (none)',
    ],
    [
      JSON.stringify({...SCHEMA_VERSIONS, future_layer: '1'}),
      'future_layer, a format the Study reader does not know',
    ],
  ])
    assert.ok(
      unreadable('r', recorded).some(text => text.includes(expected)),
      recorded,
    );
});

test('re-preparing a book replaces its overlapping outputs and keeps the rest', async () => {
  const w = world();
  await runBook(w, prepareTask('exo', 'e1'));
  const before = membersOf(w, selected(w).current_release_id);
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('gen', 'g2', {steps: ['build']}), 'rev-1', {
    tag: 'corrected',
  });
  const after = membersOf(w, selected(w).current_release_id);
  assert.equal(after.length, 6);
  for (const id of before) assert.ok(after.includes(id), 'Exodus untouched');
  const genesis = after.filter(id => !before.includes(id));
  const corrected = w.db.sqlite
    .prepare(
      `SELECT id FROM prepared_outputs WHERE id IN (${genesis.map(() => '?').join(',')})`,
    )
    .all(...genesis) as Array<{id: string}>;
  assert.equal(
    corrected.length,
    4,
    'the four corrected Genesis outputs replace the old four',
  );
});

test('scope failures leave the current release unchanged and block the task', async () => {
  const cases: Array<
    [
      string,
      {damage?: Damage; beforeQuality?: (w: World) => void; revision?: string},
      string,
    ]
  > = [
    [
      'missing object',
      {beforeQuality: w => w.objects.sizes.clear()},
      'missing from storage',
    ],
    [
      'wrong size',
      {
        beforeQuality: w => {
          for (const key of w.objects.sizes.keys())
            w.objects.sizes.set(key, 11);
        },
      },
      'bytes',
    ],
    ['not admitted', {revision: 'rev-na'}, 'not admitted for both hosts'],
    [
      'partial coverage',
      {damage: {skipWordCoverage: 'Gen.1.3'}},
      'word_exact is not available',
    ],
    [
      'unsupported format',
      {damage: {format: 'image/png'}},
      'unsupported format',
    ],
    [
      'missing v2 directory',
      {damage: {noDirectory: true}},
      'has no application/x-ndjson; profile=index-directory file',
    ],
  ];
  for (const [name, options, expected] of cases) {
    const w = world();
    const revision = options.revision ?? 'rev-1';
    if (revision !== 'rev-1') source(w.db, revision, 0);
    const request = prepareTask('gen', 'g1', {
      inputs: [{kind: 'source_revision', id: revision}],
      decision_refs: [
        {kind: 'admission', ref: 'owner-decision:1', subject: revision},
      ],
    });
    const {taskId} = await runBook(w, request, revision, {
      damage: options.damage,
      beforeQuality: () => options.beforeQuality?.(w),
    });
    const task = (await taskReport(w.db, owner, taskId))!;
    assert.equal(task.checks.scope, 'failed', name);
    assertBlockedBy(w, task, expected, name);
    assert.equal(
      w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM releases').get()?.n,
      0,
      name,
    );
  }
});

test('outputs from a source revision the task does not name fail the scope check', async () => {
  const w = world();
  source(w.db, 'rev-other');
  const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-other');
  const task = (await taskReport(w.db, owner, taskId))!;
  assert.equal(task.state, 'blocked');
  assert.ok(
    task.limitations.some(text =>
      text.includes('which the task does not name'),
    ),
  );
});

test('the task must ask for the recipe extent and capabilities before anything is dispatched', async () => {
  const w = world();
  const cases: Array<[string, Partial<TaskRequest>, string]> = [
    ['x1', {extent: {book: 'exo'}}, "recipe's extent"],
    ['x2', {capabilities: ['lemma_exact']}, 'does not provide'],
  ];
  for (const [key, change, text] of cases) {
    const created = await requestTask(
      w.db,
      owner,
      prepareTask('gen', key, change),
    );
    const id = (created as {task: {id: string}}).task.id;
    const progress = await advance(w.db, w.github, id, w.objects);
    assert.equal(progress.state, 'blocked');
    assert.ok(progress.limitation?.includes(text));
  }
  assert.equal(w.gh.runs.size, 0);
});

test('a checked candidate does not overwrite a newer change to the same source extent', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    release: false,
  });
  const second = await runBook(w, prepareTask('gen', 'g2'), 'rev-1', {
    tag: 'newer',
  });
  assert.equal(second.task.state, 'completed');
  const before = selected(w).current_release_id;
  const refused = await releaseBuild(w, first.taskId, 'release-old');
  assert.equal(refused.report.state, 'blocked');
  assert.ok(
    refused.report.limitations.some(text =>
      text.includes('same source extent'),
    ),
  );
  assert.equal(selected(w).current_release_id, before);
});

test('a lost selection response is settled by reading the selection back', async () => {
  const w = world();
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async statements => {
    const result = await batch(statements);
    const state = w.db.sqlite
      .prepare(
        `SELECT state FROM maintenance_tasks WHERE request_key = 'release-g1'`,
      )
      .get() as {state: string} | undefined;
    if (state?.state === 'completed')
      throw new Error('connection lost after commit');
    return result;
  };
  const {task} = await runBook(w, prepareTask('gen', 'g1'));
  assert.equal(task.state, 'completed');
  assert.equal(
    selected(w).current_release_id,
    task.selection.candidate_release_id,
  );
});

test('pause and cancel stop promotion; resume runs the check again', async () => {
  const w = world();
  const {id, refs} = await preparedGenesis(w);
  const paused = (await taskReport(w.db, owner, id))!;
  assert.equal(
    (await controlTask(w.db, owner, id, paused.revision, 'pause')).status,
    'ok',
  );
  await report(w, id, 'quality', {
    output_refs: refs,
    quality_receipt_ref: receipt(w, id),
  });
  assert.equal((await taskReport(w.db, owner, id))!.state, 'paused');
  assert.equal(
    selected(w).current_release_id,
    null,
    'paused work is not promoted',
  );
  const now = (await taskReport(w.db, owner, id))!;
  assert.equal(
    (await controlTask(w.db, owner, id, now.revision, 'resume')).status,
    'ok',
  );
  await advance(w.db, w.github, id, w.objects);
  assert.equal(
    (await taskReport(w.db, owner, id))!.state,
    'checked',
    'resumed work finishes as a checked build',
  );
  assert.equal(selected(w).current_release_id, null);
});

test('rollback validates the previous release and selects it through the same gate', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const second = selected(w).current_release_id;
  const id = await rollBack(w, 'rb1');
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.state, 'completed');
  assert.equal(task.data_current, true);
  assert.deepEqual(selected(w), {
    current_release_id: first.task.selection.candidate_release_id,
    previous_release_id: second,
  });
});

test('rollback without an eligible previous release reports a limitation and changes nothing', async () => {
  const w = world();
  const none = await requestTask(w.db, owner, {
    request_key: 'rb0',
    instruction: 'Roll back',
    steps: ['rollback'],
  });
  await advance(
    w.db,
    w.github,
    (none as {task: {id: string}}).task.id,
    w.objects,
  );
  let task = (await taskReport(
    w.db,
    owner,
    (none as {task: {id: string}}).task.id,
  ))!;
  assert.ok(
    task.limitations.some(text => text.includes('No previous release')),
  );
  await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const before = selected(w);
  for (const id of membersOf(w, before.previous_release_id))
    for (const row of w.db.sqlite
      .prepare('SELECT registered_locator FROM artifacts WHERE output_id = ?')
      .all(id) as Array<{registered_locator: string}>)
      w.objects.sizes.delete(row.registered_locator);
  const id = await rollBack(w, 'rb1');
  task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.data_current, false);
  assert.ok(task.limitations.some(text => text.includes('not eligible')));
  assert.deepEqual(selected(w), before);
});

/** Whether the owner's exclusion of the second source is in force (1) or lifted (0). */
function exclusionActive(w: ReturnType<typeof world>) {
  return w.db.sqlite
    .prepare(
      `SELECT active FROM maintenance_exclusions WHERE source_or_component_id = 'rev-2'`,
    )
    .get()?.active;
}

test('removal drops a source, records the exclusion, and later candidates of that source are refused', async () => {
  const w = world();
  await twoBooks(w);
  assert.equal(membersOf(w, selected(w).current_release_id).length, 6);
  const created = await requestTask(w.db, owner, {
    request_key: 'rm1',
    instruction: 'Remove the second source',
    steps: ['remove'],
    inputs: [{kind: 'source_revision', id: 'rev-2'}],
    decision_refs: [
      {kind: 'exclusion', ref: 'owner-decision:7', subject: 'rev-2'},
    ],
  });
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  assert.equal(membersOf(w, selected(w).current_release_id).length, 4);
  assert.equal(exclusionActive(w), 1);
  // The exclusion survives: preparing that source again is refused, and so is rolling back to it.
  const again = await runBook(
    w,
    prepareTask('exo', 'e2', {
      inputs: [{kind: 'source_revision', id: 'rev-2'}],
    }),
    'rev-2',
    {tag: 'again'},
  );
  assert.equal(again.task.state, 'blocked');
  assert.ok(
    again.task.limitations.some(text => text.includes('excluded by the owner')),
  );
  const rollbackId = await rollBack(w, 'rb1');
  assert.equal(
    (await taskReport(w.db, owner, rollbackId))!.data_current,
    false,
  );
  // Only an explicit owner exclusion decision on a task that adds the source lifts it.
  const lifted = await runBook(
    w,
    prepareTask('exo', 'e3', {
      inputs: [{kind: 'source_revision', id: 'rev-2'}],
      decision_refs: [
        {kind: 'exclusion', ref: 'owner-decision:8', subject: 'rev-2'},
      ],
    }),
    'rev-2',
    {tag: 'lifted'},
  );
  assert.equal(
    lifted.task.state,
    'completed',
    JSON.stringify(lifted.task.limitations),
  );
  assert.equal(exclusionActive(w), 0);
});

test('restore validation blocks restored open work and selects a restored release only when instructed', async () => {
  const w = world();
  const first = await runBook(w, prepareTask('gen', 'g1'));
  await runBook(w, prepareTask('exo', 'e1'));
  const openId = await openBuild(w);
  const checkId = await validateRestore(w, 'vr1');
  const report1 = (await taskReport(w.db, owner, checkId))!;
  assert.equal(report1.state, 'completed');
  assert.ok(
    report1.limitations.includes('The restored releases passed validation.'),
  );
  assert.equal(report1.data_current, false);
  assert.equal(
    (await taskReport(w.db, owner, openId))!.state,
    'blocked',
    'restored running work is not restarted',
  );
  const select = await requestTask(w.db, owner, {
    request_key: 'vr2',
    instruction: 'Select the first release',
    steps: ['validate_restore'],
    constraints: {select_release: first.task.selection.candidate_release_id},
  });
  const selectId = (select as {task: {id: string}}).task.id;
  await advance(w.db, w.github, selectId, w.objects);
  assert.equal((await taskReport(w.db, owner, selectId))!.data_current, true);
  assert.equal(
    selected(w).current_release_id,
    first.task.selection.candidate_release_id,
  );
});

test('membership keeps unrelated outputs, replaces overlapping ones and refuses orphaned dependants', () => {
  const output = (
    id: string,
    kind: string,
    revision: string,
    units: string[],
    dependencies: string[] = [],
  ) => ({
    id,
    kind,
    revisions: [revision],
    extent: {coordinate_version: C, unit_ids: units},
    dependencies,
  });
  const base = [
    output('e1', 'evidence', 'r', ['a', 'b']),
    output('i1', 'source_search', 'r', ['a', 'b'], ['e1']),
    output('e2', 'evidence', 'r', ['c']),
    output('x1', 'evidence', 'other', ['a']),
  ];
  const fresh = [
    output('e3', 'evidence', 'r', ['b']),
    output('i3', 'source_search', 'r', ['b'], ['e3']),
  ];
  const built = membership(base, fresh, new Set(), new Set());
  assert.deepEqual(built.ids, ['e2', 'e3', 'i3', 'x1']);
  assert.deepEqual(built.problems, []);
  const orphan = membership(
    base,
    [output('e4', 'evidence', 'r', ['a'])],
    new Set(),
    new Set(),
  );
  // e4 replaces e1, but the kept index i1 still depends on e1: refused.
  assert.ok(orphan.problems.some(text => text.includes('i1')));
  assert.deepEqual(membership(base, [], new Set(), new Set(['r'])).ids, ['x1']);
});

test('an aid output replaces the evidence output that held the same aids, and only that', () => {
  const output = (
    id: string,
    kind: string,
    revision: string,
    units: string[],
    coordinate = 'language-aids/bdb/1',
  ) => ({
    id,
    kind,
    revisions: [revision],
    extent: {coordinate_version: coordinate, unit_ids: units},
    dependencies: [],
  });
  const base = [
    output('old-aid', 'evidence', 'lex', ['p000']),
    output('old-other', 'evidence', 'lex', ['p001']),
    output('text', 'evidence', 'lex', ['p000'], 'synthetic-verses/1'),
    output('other-source', 'evidence', 'other', ['p000']),
  ];
  const built = membership(
    base,
    [output('new-aid', 'aid_entries', 'lex', ['p000'])],
    new Set(),
    new Set(),
  );
  assert.deepEqual(built.dropped, ['old-aid']);
  assert.deepEqual(built.ids, ['new-aid', 'old-other', 'other-source', 'text']);
  // The other way round, and a newer aid output over the same units, behave as before.
  const aids = [output('aid-1', 'aid_entries', 'lex', ['p000'])];
  assert.deepEqual(
    membership(
      aids,
      [output('plain', 'evidence', 'lex', ['p000'])],
      new Set(),
      new Set(),
    ).ids,
    ['aid-1', 'plain'],
  );
  assert.deepEqual(
    membership(
      aids,
      [output('aid-2', 'aid_entries', 'lex', ['p000'])],
      new Set(),
      new Set(),
    ).ids,
    ['aid-2'],
  );
});

test('a release of language-aid outputs validates: their entries file format is a stored format', async () => {
  const w = world();
  const extent = JSON.stringify({
    coordinate_version: 'language-aids/bdb/1',
    unit_ids: ['p000'],
  });
  w.db.sqlite
    .prepare('INSERT INTO prepared_outputs VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      'aid_entries:one',
      'aid_entries',
      '["rev-1"]',
      'language-aids/2',
      '{}',
      extent,
      '{"dependencies":[]}',
    );
  const digest = sha('entries');
  const locator = `prepared/${digest}/aid-entries.ndjson`;
  w.db.sqlite
    .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, 10, ?, ?)')
    .run(
      'aid_entries:one:entries',
      'rev-1',
      'aid_entries:one',
      digest,
      'application/x-ndjson; profile=aid-entries',
      locator,
    );
  w.db.sqlite
    .prepare(
      `INSERT INTO coverage VALUES ('aid_entries:one', 'rev-1', ?, 'lexicon_entry', 'available', 'language-aids/2', 'aid_entries:one:entries', '[]', NULL)`,
    )
    .run(extent);
  w.db.sqlite
    .prepare(
      `INSERT INTO aid_entries VALUES ('aid_entries:one', 0, 'lexicon_entry', 'k', 'H0001', 0, 10, ?)`,
    )
    .run(digest);
  w.db.sqlite
    .prepare(
      `INSERT INTO releases VALUES ('r-aid', 'm', 'r', ?, 'c', 'q', 's')`,
    )
    .run(JSON.stringify(SCHEMA_VERSIONS));
  w.db.sqlite
    .prepare(`INSERT INTO release_outputs VALUES ('r-aid', 'aid_entries:one')`)
    .run();
  const check = await validateRelease(w.db, new Map([[locator, 10]]), 'r-aid');
  assert.deepEqual(check.problems, []);
  const missing = await validateRelease(w.db, new Map(), 'r-aid');
  assert.ok(
    missing.problems.some(text => text.includes('is missing from storage')),
  );
});

test('R25-1: every result reference must be a saved artifact with its digest and size, and the receipt must be stored', async () => {
  const cases: Array<
    [
      string,
      (
        w: World,
        refs: Array<{artifact_id: string; sha256: string; byte_count: number}>,
        taskId: string,
      ) => Record<string, unknown>,
      string,
    ]
  > = [
    [
      'unknown artifact',
      (w, refs, id) => ({
        output_refs: [
          ...refs,
          {artifact_id: 'artifact-ghost', sha256: sha('ghost'), byte_count: 1},
        ],
        quality_receipt_ref: receipt(w, id),
      }),
      'not a saved artifact',
    ],
    [
      'wrong digest',
      (w, refs, id) => ({
        output_refs: refs.map((ref, index) =>
          index ? ref : {...ref, sha256: sha('other')},
        ),
        quality_receipt_ref: receipt(w, id),
      }),
      'does not match the saved artifact',
    ],
    [
      'receipt not stored',
      (w, refs, id) => {
        const ref = receipt(w, id);
        w.objects.sizes.delete(`prepared/receipts/${ref.sha256}.json`);
        return {output_refs: refs, quality_receipt_ref: ref};
      },
      'receipt is not stored',
    ],
    [
      'malformed receipt',
      (w, refs, id) => ({
        output_refs: refs,
        quality_receipt_ref: {...receipt(w, id), artifact_id: 'receipt'},
      }),
      'malformed',
    ],
  ];
  for (const [name, quality, expected] of cases) {
    const w = world();
    const {id, refs} = await preparedGenesis(w);
    await report(w, id, 'quality', quality(w, refs, id));
    const task = (await taskReport(w.db, owner, id))!;
    assertBlockedBy(w, task, expected, name);
  }
});

test('R25-2: every named source revision is checked, and recipes without unit lists are refused before dispatch', async () => {
  const w = world();
  source(w.db, 'rev-extra');
  // An output that also used another saved, admitted source revision the task does not name.
  const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    beforeQuality: () =>
      w.db.sqlite
        .exec(`PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;
      DROP TRIGGER prepared_identity_stable;
      UPDATE prepared_outputs SET input_revisions_json = '["rev-1","rev-extra"]' WHERE kind = 'evidence';
      PRAGMA foreign_keys = ON`),
  });
  const task = (await taskReport(w.db, owner, taskId))!;
  assert.equal(task.state, 'blocked');
  assert.ok(
    task.limitations.some(text =>
      text.includes('rev-extra, which the task does not name'),
    ),
  );

  const other = world();
  const book = recipeFor('gen', [['Gen.1.1']]);
  (book.units[1].native_extent as Record<string, unknown>) = {book: 'gen'};
  const gh = fakeGitHub({recipes: {'collection/recipes/gen.json': book}});
  const github = new GitHubActions(
    {repository: 'owner/app', token: 'synthetic-token'},
    gh.fetcher,
  );
  const created = await requestTask(other.db, owner, prepareTask('gen', 'g2'));
  const progress = await advance(
    other.db,
    github,
    (created as {task: {id: string}}).task.id,
    other.objects,
  );
  assert.equal(progress.state, 'blocked');
  assert.ok(progress.limitation?.includes('must list its native unit_ids'));
  assert.equal(gh.runs.size, 0);
});

test('R25-3: an exclusion recorded after the build makes the release refuse; a new build refuses the source', async () => {
  const w = world();
  const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    release: false,
  });
  w.db.sqlite
    .prepare(
      `INSERT INTO maintenance_exclusions VALUES ('rev-1', 'owner-decision:5', ?, 1, 1)`,
    )
    .run(taskId);
  const refused = await releaseBuild(w, taskId, 'release-g1');
  assert.equal(refused.report.state, 'blocked');
  assert.ok(
    refused.report.limitations.some(text =>
      text.includes('is excluded by the owner (rev-1)'),
    ),
  );
  assert.equal(selected(w).current_release_id, null);
  const rebuilt = await runBook(w, prepareTask('gen', 'g2'), 'rev-1', {
    tag: 'again',
  });
  assert.equal(rebuilt.task.state, 'blocked');
  assert.ok(
    rebuilt.task.limitations.some(text =>
      text.includes('excluded by the owner'),
    ),
  );
});

test('R25-4: removal records exclusions without a matching current source, may empty the release, and ignores an unrelated exclusion that lands meanwhile', async () => {
  const w = world();
  const remove = async (key: string) => {
    const created = await requestTask(w.db, owner, {
      request_key: key,
      instruction: 'Remove rev-1',
      steps: ['remove'],
      inputs: [{kind: 'source_revision', id: 'rev-1'}],
      decision_refs: [
        {kind: 'exclusion', ref: `owner-decision:${key}`, subject: 'rev-1'},
      ],
    });
    return (created as {task: {id: string}}).task.id;
  };
  // Nothing current: the exclusion is still recorded.
  const first = await remove('rm0');
  await advance(w.db, w.github, first, w.objects);
  assert.equal((await taskReport(w.db, owner, first))!.state, 'completed');
  assert.equal(
    w.db.sqlite
      .prepare(
        `SELECT active FROM maintenance_exclusions WHERE decision_ref = 'owner-decision:rm0'`,
      )
      .get()?.active,
    1,
  );
  // Lift it, load the book, then remove the only source: the release becomes empty.
  await runBook(
    w,
    prepareTask('gen', 'g1', {
      decision_refs: [
        {kind: 'exclusion', ref: 'owner-decision:lift', subject: 'rev-1'},
      ],
    }),
  );
  assert.equal(membersOf(w, selected(w).current_release_id).length, 4);
  // An exclusion of something unrelated lands just before the write: the removal still goes through.
  const taskIdOf = (key: string) =>
    (
      w.db.sqlite
        .prepare(`SELECT id FROM maintenance_tasks WHERE request_key = ?`)
        .get(key) as {id: string}
    ).id;
  const reached = beforeWrite(w, 'rm1', () =>
    w.db.sqlite
      .prepare(
        `INSERT INTO maintenance_exclusions VALUES ('unrelated', 'owner-decision:x', ?, 1, 1)`,
      )
      .run(taskIdOf('rm1')),
  );
  const second = await remove('rm1');
  await advance(w.db, w.github, second, w.objects);
  assert.ok(reached());
  const task = (await taskReport(w.db, owner, second))!;
  assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  assert.deepEqual(membersOf(w, selected(w).current_release_id), []);
});

test('R25-4b: an exclusion of a source that stays, landing just before the write, refuses the removal and writes nothing', async () => {
  const w = world();
  await twoBooks(w);
  const before = selected(w);
  const rows = releaseCounts(w);
  const created = await requestTask(w.db, owner, {
    request_key: 'rm9',
    instruction: 'Remove rev-2',
    steps: ['remove'],
    inputs: [{kind: 'source_revision', id: 'rev-2'}],
    decision_refs: [
      {kind: 'exclusion', ref: 'owner-decision:r2', subject: 'rev-2'},
    ],
  });
  const id = (created as {task: {id: string}}).task.id;
  const reached = beforeWrite(w, 'rm9', () =>
    w.db.sqlite
      .prepare(
        `INSERT INTO maintenance_exclusions VALUES ('rev-1:work', 'owner-decision:late', ?, 1, 1)`,
      )
      .run(id),
  );
  await advance(w.db, w.github, id, w.objects);
  assert.ok(reached());
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.state, 'blocked');
  assert.ok(
    task.limitations.some(text =>
      text.includes('excluded by the owner (rev-1:work)'),
    ),
  );
  assert.deepEqual(selected(w), before, 'the selection did not change');
  assert.deepEqual(
    releaseCounts(w),
    rows,
    'no release or member was left behind',
  );
  assert.deepEqual(
    w.db.sqlite
      .prepare(
        'SELECT source_or_component_id AS id FROM maintenance_exclusions',
      )
      .all()
      .map(row => row.id),
    ['rev-1:work'],
    "the removal's own exclusion was not written",
  );
});

/** Another selection lands: a new release holding what the current one holds. */
function moveCurrent(w: World, id: string) {
  const current = selected(w).current_release_id;
  w.db.sqlite
    .exec(`INSERT INTO releases VALUES ('${id}', 'm', 'r', '{}', 'c', 'q', 's');
    INSERT INTO release_outputs SELECT '${id}', output_id FROM release_outputs WHERE release_id = '${current}';
    UPDATE release_selection SET previous_release_id = current_release_id, current_release_id = '${id}'`);
}

test('a selection that moves just before the write is built again on the new current release', async () => {
  const w = world();
  const taskId = await stageGenesis(w);
  const reached = beforeWrite(w, 'release-g1', () =>
    moveCurrent(w, 'release-other'),
  );
  const released = await releaseBuild(w, taskId, 'release-g1');
  assert.ok(reached());
  assert.equal(
    released.report.state,
    'completed',
    JSON.stringify(released.report.limitations),
  );
  assert.equal(selected(w).previous_release_id, 'release-other');
  assert.equal(membersOf(w, selected(w).current_release_id).length, 6);
});

test('a selection that keeps moving blocks the task with the reason and changes nothing', async () => {
  const w = world();
  const taskId = await stageGenesis(w);
  let moves = 0;
  beforeWrite(
    w,
    'release-g1',
    () => moveCurrent(w, `release-other-${++moves}`),
    () => false,
    true,
  );
  const released = await releaseBuild(w, taskId, 'release-g1');
  assert.equal(released.report.state, 'blocked');
  assert.ok(
    released.report.limitations.some(text => text.includes('kept changing')),
  );
  assert.equal(moves, 3, 'a small fixed number of tries');
  assert.equal(selected(w).current_release_id, `release-other-${moves}`);
  assert.equal(
    (await taskReport(w.db, owner, taskId))!.state,
    'checked',
    'the build can still be released later',
  );
});

test('a release task whose revision moves just before the write changes nothing', async () => {
  const w = world();
  const taskId = await stageGenesis(w);
  const before = selected(w);
  const rows = releaseCounts(w);
  beforeWrite(w, 'release-g1', () =>
    w.db.sqlite
      .prepare(
        `UPDATE maintenance_tasks SET revision = revision + 1 WHERE request_key = 'release-g1'`,
      )
      .run(),
  );
  const released = await releaseBuild(w, taskId, 'release-g1');
  assert.notEqual(released.report.state, 'completed');
  assert.deepEqual(selected(w), before);
  assert.deepEqual(releaseCounts(w), rows);
  assert.equal((await taskReport(w.db, owner, taskId))!.state, 'checked');
});

test('R110-2: a task whose selection was refused is not completed because another task selected the same release', async () => {
  const w = world();
  const taskId = await stageGenesis(w);
  // Another release task makes the same candidate current just before this one writes.
  const reached = beforeWrite(w, 'release-a', async () => {
    const other = await releaseBuild(w, taskId, 'release-b');
    assert.equal(other.report.state, 'completed');
  });
  const first = (await taskReport(w.db, owner, taskId))!.selection
    .candidate_release_id;
  const refused = await releaseBuild(w, taskId, 'release-a');
  assert.ok(reached());
  assert.notEqual(refused.report.state, 'completed');
  assert.equal(
    refused.report.data_current,
    false,
    'it did not select anything',
  );
  assert.equal(selected(w).current_release_id, first);
  const selecting = w.db.sqlite
    .prepare(
      `SELECT request_key FROM maintenance_tasks WHERE json_extract(outcome_json, '$.selection.became_current') = 1 AND request_key IN ('release-a', 'release-b')`,
    )
    .all()
    .map(row => row.request_key);
  assert.deepEqual(
    selecting,
    ['release-b'],
    'only the task that selected claims it',
  );
});

test('R25-5: rollback refuses a release with a missing dependency, and removal refuses survivors that fail validation', async () => {
  const w = world();
  await runBook(w, prepareTask('gen', 'g1'));
  const index = (
    w.db.sqlite
      .prepare(
        `SELECT id FROM prepared_outputs WHERE kind = 'source_search' LIMIT 1`,
      )
      .get() as {id: string}
  ).id;
  w.db.sqlite.exec(
    `INSERT INTO releases VALUES ('release-broken', 'm', 'r', '{}', 'c', 'q', 's')`,
  );
  w.db.sqlite
    .prepare(`INSERT INTO release_outputs VALUES ('release-broken', ?)`)
    .run(index);
  await assertRollbackBlocked(
    w,
    'release-broken',
    'which is not in the release',
  );

  const v = world();
  source(v.db, 'rev-2');
  await runBook(v, prepareTask('gen', 'g1'));
  await runBook(
    v,
    prepareTask('exo', 'e1', {
      inputs: [{kind: 'source_revision', id: 'rev-2'}],
    }),
    'rev-2',
  );
  for (const key of [...v.objects.sizes.keys()])
    if (!key.includes('receipts')) v.objects.sizes.delete(key);
  const removal = await requestTask(v.db, owner, {
    request_key: 'rm1',
    instruction: 'Remove rev-2',
    steps: ['remove'],
    inputs: [{kind: 'source_revision', id: 'rev-2'}],
  });
  const removalId = (removal as {task: {id: string}}).task.id;
  const before = selected(v);
  await advance(v.db, v.github, removalId, v.objects);
  const removed = (await taskReport(v.db, owner, removalId))!;
  assert.equal(removed.state, 'blocked');
  assert.ok(
    removed.limitations.some(text => text.includes('missing from storage')),
  );
  assert.deepEqual(selected(v), before);
});

/** Point the previous release at a faulty one; rolling back must be blocked with the reason. */
async function assertRollbackBlocked(
  w: ReturnType<typeof world>,
  previous: string,
  reason: string,
) {
  w.db.sqlite.exec(
    `UPDATE release_selection SET previous_release_id = '${previous}'`,
  );
  const id = await rollBack(w, 'rb1');
  const task = (await taskReport(w.db, owner, id))!;
  assert.equal(task.data_current, false);
  assert.ok(task.limitations.some(text => text.includes(reason)));
}

/** An unfinished build of Genesis, advanced once, so it is open work. */
async function openBuild(w: ReturnType<typeof world>) {
  const open = await requestTask(w.db, owner, prepareTask('gen', 'g9'));
  const id = (open as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  return id;
}

/** Request a restore validation, advance it, and return its task ID. */
async function validateRestore(
  w: ReturnType<typeof world>,
  key: string,
  constraints?: Record<string, unknown>,
) {
  const created = await requestTask(w.db, owner, {
    request_key: key,
    instruction: 'Check the restore',
    steps: ['validate_restore'],
    ...(constraints ? {constraints} : {}),
  });
  const id = (created as {task: {id: string}}).task.id;
  await advance(w.db, w.github, id, w.objects);
  return id;
}

/** Move a task's revision just before a block is written, as a concurrent change would. */
function moveRevisionWhenBlocking(
  w: ReturnType<typeof world>,
  prepare: typeof w.db.prepare,
  taskId: string,
  moves: () => boolean,
) {
  w.db.prepare = sql => {
    const statement = prepare(sql);
    if (
      !sql.includes("json_insert(json_extract(outcome_json, '$.limitations')")
    )
      return statement;
    const bind = statement.bind.bind(statement);
    return {
      ...statement,
      bind: (...values: unknown[]) => {
        const bound = bind(...values);
        return {
          ...bound,
          all: async () => {
            if (moves())
              w.db.sqlite
                .prepare(
                  `UPDATE maintenance_tasks SET revision = revision + 1 WHERE id = ?`,
                )
                .run(taskId);
            return bound.all();
          },
        };
      },
    };
  };
}

test('R25-6: restored tasks are blocked even when their revision moves meanwhile, and selecting a restored release still follows', async () => {
  const w = world();
  await runBook(w, prepareTask('gen', 'g1'));
  const openId = await openBuild(w);
  const prepare = w.db.prepare.bind(w.db);
  moveRevisionWhenBlocking(w, prepare, openId, () => true);
  const checkId = await validateRestore(w, 'vr1');
  assert.equal(
    (await taskReport(w.db, owner, openId))!.state,
    'blocked',
    'blocked although its revision moved at the same moment',
  );
  assert.ok(
    (await taskReport(w.db, owner, checkId))!.limitations.includes(
      'The restored releases passed validation.',
    ),
  );

  // Work that keeps changing does not hold the restore back: it is blocked and the release is selected.
  const again = await requestTask(w.db, owner, prepareTask('exo', 'e9'));
  const againId = (again as {task: {id: string}}).task.id;
  await advance(w.db, w.github, againId, w.objects);
  moveRevisionWhenBlocking(w, prepare, againId, () => true);
  await runBook(w, prepareTask('exo', 'e1'));
  const before = selected(w);
  const secondId = await validateRestore(w, 'vr2', {
    select_release: before.previous_release_id,
  });
  const report2 = (await taskReport(w.db, owner, secondId))!;
  assert.equal(report2.data_current, true);
  assert.equal(selected(w).current_release_id, before.previous_release_id);
  assert.equal((await taskReport(w.db, owner, againId))!.state, 'blocked');
});

test('R25-7: an index output without its postings and manifest files makes a release ineligible', async () => {
  const w = world();
  await runBook(w, prepareTask('gen', 'g1'));
  const partial = savePrepared(w, 'rev-1', 'partial', ['Gen.1.1'], 'partial', {
    noManifest: true,
  });
  w.db.sqlite.exec(
    `INSERT INTO releases VALUES ('release-partial', 'm', 'r', '{}', 'c', 'q', 's')`,
  );
  for (const output of partial.outputs)
    w.db.sqlite
      .prepare(`INSERT INTO release_outputs VALUES ('release-partial', ?)`)
      .run(output);
  await assertRollbackBlocked(
    w,
    'release-partial',
    'has no application/json file',
  );
});

test('R25-8: removal checks what stays against its new exclusions, and a stale check never replays exclusion writes', async () => {
  const w = world();
  await twoBooks(w);
  const before = selected(w);
  // The exclusion subject is an ancestor of rev-1, which would stay selected: refused.
  const wide = await requestTask(w.db, owner, {
    request_key: 'rm1',
    instruction: 'Remove rev-2',
    steps: ['remove'],
    inputs: [{kind: 'source_revision', id: 'rev-2'}],
    decision_refs: [
      {kind: 'exclusion', ref: 'owner-decision:w', subject: 'rev-1:work'},
    ],
  });
  const wideId = (wide as {task: {id: string}}).task.id;
  await advance(w.db, w.github, wideId, w.objects);
  const refused = (await taskReport(w.db, owner, wideId))!;
  assert.equal(refused.state, 'blocked');
  assert.ok(
    refused.limitations.some(text =>
      text.includes('excluded by the owner (rev-1:work)'),
    ),
  );
  assert.deepEqual(selected(w), before);
  assert.equal(
    w.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM maintenance_exclusions')
      .get()?.n,
    0,
  );

  // A no-op removal that records an exclusion, checked twice from the same stale read.
  const noop = await requestTask(w.db, owner, {
    request_key: 'rm2',
    instruction: 'Exclude rev-3',
    steps: ['remove'],
    inputs: [{kind: 'source_revision', id: 'rev-3'}],
    decision_refs: [
      {kind: 'exclusion', ref: 'owner-decision:3', subject: 'rev-3'},
    ],
  });
  const noopId = (noop as {task: {id: string}}).task.id;
  const stale = w.db.sqlite
    .prepare('SELECT * FROM maintenance_tasks WHERE id = ?')
    .get(noopId) as never;
  assert.equal((await selectDirect(w.db, w.objects, stale)).state, 'completed');
  w.db.sqlite.exec(
    `UPDATE maintenance_exclusions SET active = 0, revision = 9 WHERE source_or_component_id = 'rev-3'`,
  ); // a later lift
  await selectDirect(w.db, w.objects, stale);
  assert.equal(
    w.db.sqlite
      .prepare(
        `SELECT active FROM maintenance_exclusions WHERE source_or_component_id = 'rev-3'`,
      )
      .get()?.active,
    0,
    'the stale check did not re-activate the lifted exclusion',
  );
});

test('a release refuses an unknown task, an unfinished build and a candidate that is already current', async () => {
  const w = world();
  const unknown = await releaseBuild(w, 'no-such-task', 'release-none');
  assert.equal(unknown.report.state, 'blocked');
  assert.ok(
    unknown.report.limitations.some(text => text.includes('was not found')),
  );
  const created = await requestTask(w.db, owner, prepareTask('gen', 'g1'));
  const open = (created as {task: {id: string}}).task.id;
  const unfinished = await releaseBuild(w, open, 'release-open');
  assert.equal(unfinished.report.state, 'blocked');
  assert.ok(
    unfinished.report.limitations.some(text => text.includes('checked build')),
  );
  const done = await runBook(w, prepareTask('exo', 'e1'));
  assert.equal(
    selected(w).current_release_id,
    done.task.selection.candidate_release_id,
  );
  const again = await releaseBuild(w, done.taskId, 'release-again');
  assert.equal(again.report.state, 'blocked');
  assert.ok(
    again.report.limitations.some(text => text.includes('already current')),
    JSON.stringify(again.report.limitations),
  );
});

test('a build stays checked until released; a cancelled or superseded build is never released', async () => {
  const w = world();
  const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    release: false,
  });
  const built = (await taskReport(w.db, owner, taskId))!;
  assert.equal(built.state, 'checked');
  assert.equal(built.data_current, false);
  // Advancing a checked build does nothing more: no second check, no selection.
  await advance(w.db, w.github, taskId, w.objects);
  assert.equal((await taskReport(w.db, owner, taskId))!.state, 'checked');
  assert.equal(selected(w).current_release_id, null);
  // The owner can still cancel it, and then it cannot be released.
  assert.equal(
    (await controlTask(w.db, owner, taskId, built.revision, 'cancel')).status,
    'ok',
  );
  const refused = await releaseBuild(w, taskId, 'release-cancelled');
  assert.equal(refused.report.state, 'blocked');
  assert.ok(
    refused.report.limitations.some(text =>
      text.includes('cancelled or superseded'),
    ),
  );
  assert.equal(selected(w).current_release_id, null);
  // A superseded build is refused the same way.
  const other = await runBook(w, prepareTask('exo', 'e1'), 'rev-1', {
    release: false,
  });
  w.db.sqlite
    .prepare(
      `UPDATE maintenance_tasks SET state = 'superseded', revision = revision + 1 WHERE id = ?`,
    )
    .run(other.taskId);
  const second = await releaseBuild(w, other.taskId, 'release-superseded');
  assert.equal(second.report.state, 'blocked');
  assert.equal(selected(w).current_release_id, null);
});

for (const state of ['cancelled', 'superseded']) {
  test(`R58-4: a build ${state} between validation and selection is not selected`, async () => {
    const w = world();
    const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
      release: false,
    });
    const rows = releaseCounts(w);
    beforeWrite(w, 'release-g1', () =>
      w.db.sqlite
        .prepare(
          `UPDATE maintenance_tasks SET state = ?, revision = revision + 1 WHERE id = ?`,
        )
        .run(state, taskId),
    );
    const released = await releaseBuild(w, taskId, 'release-g1');
    assert.notEqual(released.report.state, 'completed');
    assert.equal(selected(w).current_release_id, null, 'nothing was selected');
    assert.equal(
      (await taskReport(w.db, owner, taskId))!.state,
      state,
      'the build is left as it was changed',
    );
    assert.deepEqual(releaseCounts(w), rows, 'no release rows are left');
  });
}

test('an interrupted release is selected again by the next check, after the same guards', async () => {
  const w = world();
  const {taskId} = await runBook(w, prepareTask('gen', 'g1'), 'rev-1', {
    release: false,
  });
  const row = w.db.sqlite
    .prepare('SELECT outcome_json FROM maintenance_tasks WHERE id = ?')
    .get(taskId) as {outcome_json: string};
  const candidate = (
    JSON.parse(row.outcome_json) as {candidate: {release_id: string}}
  ).candidate.release_id;
  // The selection batch never reaches the database: the release is left checked.
  const interrupt = interruptWrite(w, 'release-g1');
  const stuck = await releaseBuild(w, taskId, 'release-g1');
  assert.ok(['queued', 'running'].includes(stuck.report.state));
  assert.equal(selected(w).current_release_id, null);
  assert.equal(
    (await taskReport(w.db, owner, taskId))!.state,
    'checked',
    'the build is untouched',
  );
  // The next check retries and selects.
  interrupt.on = false;
  await advance(w.db, w.github, stuck.id, w.objects);
  const done = (await taskReport(w.db, owner, stuck.id))!;
  assert.equal(done.state, 'completed');
  assert.equal(selected(w).current_release_id, candidate);
  assert.equal((await taskReport(w.db, owner, taskId))!.state, 'completed');
  // A repeated advance changes nothing.
  await advance(w.db, w.github, stuck.id, w.objects);
  assert.equal(selected(w).previous_release_id, null);
});
