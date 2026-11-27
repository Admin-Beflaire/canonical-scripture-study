import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {InputRef} from '../../services/maintenance/control/src/contracts.ts';
import {outputs} from '../../services/maintenance/control/src/release-check.ts';
import {replacementProblems} from '../../services/maintenance/control/src/release-replace.ts';
import {
  releaseBuild,
  rollBack,
  runBook,
  savePrepared,
  selected,
  source,
  world,
  type Damage,
  type World,
} from './builds.ts';

/** Replacing a source revision: the five books of one real original, built with the committed
 *  recipes, and the same books for a newer revision of it. Synthetic records and bytes. */

const BOOKS = ['job', 'psa', 'pro', 'ecc', 'sng'];
const OLD = 'stepbible-tahot:5de0a47f35f0';
const NEW = 'stepbible-tahot:000000000000';

interface BookRecipe {
  id: string;
  revision: string;
  native_extent: Record<string, unknown>;
  capabilities: string[];
  task_inputs: InputRef[];
}

const committed = (book: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../collection/recipes/stepbible-tahot-${book}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as BookRecipe;

/** The recipe of a book for the old revision, or the same recipe over the newer one. */
function recipeOf(book: string, revision: string): BookRecipe {
  const recipe = committed(book);
  if (revision === OLD) return recipe;
  const id = `${recipe.id}-next`;
  return {
    ...recipe,
    id,
    revision: `${id}/1`,
    task_inputs: recipe.task_inputs.map(input =>
      input.id === OLD ? {...input, id: NEW} : input,
    ),
  };
}

function books() {
  const w = world(
    Object.fromEntries(
      [OLD, NEW]
        .flatMap(revision => BOOKS.map(book => recipeOf(book, revision)))
        .map(recipe => [`collection/recipes/${recipe.id}.json`, recipe]),
    ),
  );
  source(w.db, OLD);
  source(w.db, NEW);
  return w;
}

let sent = 0;
/** Build one book of a revision, and make it current unless `release` is false. */
function build(
  w: World,
  book: string,
  revision: string,
  options: {replaces?: boolean; release?: boolean; damage?: Damage} = {},
) {
  const recipe = recipeOf(book, revision);
  const key = `build-${++sent}`;
  return runBook(
    w,
    {
      request_key: key,
      instruction: `Build ${recipe.id}`,
      steps: ['build'],
      inputs: recipe.task_inputs,
      extent: recipe.native_extent,
      capabilities: recipe.capabilities,
      constraints: {
        recipe: recipe.id,
        ...(options.replaces ? {replaces: [OLD]} : {}),
      },
      decision_refs: recipe.task_inputs
        .filter(input => input.kind === 'acquisition')
        .map(input => ({
          kind: 'admission',
          ref: 'owner-decision:synthetic',
          subject: input.id,
        })),
    },
    revision,
    {tag: key, release: options.release, damage: options.damage},
  );
}

async function buildAll(w: World, names: string[], revision: string) {
  for (const book of names) {
    const {task} = await build(w, book, revision);
    assert.equal(task.state, 'completed', JSON.stringify(task.limitations));
  }
}

const currentRevisions = (w: World) =>
  (
    w.db.sqlite
      .prepare(
        `SELECT DISTINCT c.source_revision_id AS id FROM release_selection s
    JOIN release_outputs ro ON ro.release_id = s.current_release_id
    JOIN coverage c ON c.output_id = ro.output_id ORDER BY 1`,
      )
      .all() as Array<{id: string}>
  ).map(row => row.id);

/** The refusal names the capability and exactly the books the newer revision lacks. */
function assertRefused(limitations: string[], lacking: string) {
  const refusals = limitations.filter(text => text.startsWith('replaces '));
  assert.equal(refusals.length, 5, JSON.stringify(limitations));
  for (const text of refusals) {
    assert.ok(text.includes(`replaces ${OLD} is refused: ${NEW}`), text);
    assert.ok(text.includes(`, in ${lacking}, first `), text);
  }
}

test('replaces is refused while a book of the old revision is missing or blocked, and allowed when all are current', async () => {
  const w = books();
  await buildAll(w, BOOKS, OLD);
  const before = selected(w).current_release_id;

  const early = await build(w, 'job', NEW, {replaces: true});
  assert.equal(early.task.state, 'blocked');
  assertRefused(early.task.limitations, 'Ecc, Pro, Psa, Sng');
  assert.equal(selected(w).current_release_id, before);

  await buildAll(w, ['job', 'psa', 'pro'], NEW);
  const damaged = await build(w, 'ecc', NEW, {
    damage: {skipWordCoverage: 'Ecc.1.1'},
  });
  assert.equal(damaged.task.state, 'blocked');
  const unchanged = selected(w).current_release_id;
  const refused = await build(w, 'sng', NEW, {replaces: true});
  assert.equal(refused.task.state, 'blocked');
  assertRefused(refused.task.limitations, 'Ecc');
  assert.equal(selected(w).current_release_id, unchanged);
  assert.deepEqual(currentRevisions(w), [NEW, OLD]);

  await buildAll(w, ['ecc'], NEW);
  const last = await build(w, 'sng', NEW, {replaces: true});
  assert.equal(
    last.task.state,
    'completed',
    JSON.stringify(last.task.limitations),
  );
  assert.deepEqual(currentRevisions(w), [NEW]);
});

test('making a prepared build current applies the same replacement check', async () => {
  const w = books();
  await buildAll(w, BOOKS, OLD);
  await buildAll(w, ['job', 'psa', 'pro', 'ecc'], NEW);
  const prepared = await build(w, 'sng', NEW, {
    replaces: true,
    release: false,
  });
  assert.equal(prepared.task.state, 'checked');

  // Ecclesiastes of the newer revision leaves current data before the release.
  await rollBack(w);
  const before = selected(w).current_release_id;
  const refused = await releaseBuild(w, prepared.taskId, 'release-early');
  assert.equal(refused.report.state, 'blocked');
  assertRefused(refused.report.limitations, 'Ecc');
  assert.equal(selected(w).current_release_id, before);

  await buildAll(w, ['ecc'], NEW);
  const released = await releaseBuild(w, prepared.taskId, 'release-complete');
  assert.equal(
    released.report.state,
    'completed',
    JSON.stringify(released.report.limitations),
  );
  assert.deepEqual(currentRevisions(w), [NEW]);
});

test('replaces is refused when the records cannot show that the new data covers the old', async () => {
  const w = world();
  source(w.db, 'rev-2');
  const verses = ['Gen.1.1'];
  const saved = async (
    revision: string,
    tag: string,
    damage: Damage = {},
    coordinate = 'synthetic-verses/1',
  ) =>
    outputs(
      w.db,
      savePrepared(w, revision, tag, verses, tag, damage, {
        coordinate,
        capabilities: ['source_context', 'word_exact'],
      }).outputs,
    );
  const problems = async (
    old: Awaited<ReturnType<typeof saved>>,
    next: Awaited<ReturnType<typeof saved>>,
  ) =>
    (await replacementProblems(w.db, new Set(['rev-1']), old, next, next)).join(
      '\n',
    );
  const old = await saved('rev-1', 'old');
  const same = await saved('rev-2', 'same');
  assert.equal(await problems(old, same), '');

  const renumbered = await saved('rev-2', 'renumbered', {}, 'synthetic/2');
  assert.match(
    await problems(old, renumbered),
    /does not give, in the same native coordinates, source_context/,
  );
  const unrecorded = await saved('rev-1', 'bare', {
    skipWordCoverage: 'Gen.1.1',
  });
  assert.match(
    await problems(unrecorded, same),
    /the records do not show what output source_search:\w+ covers/,
  );
  // An evidence output of the newer revision whose coverage is only partial.
  w.db.sqlite.exec(`
    INSERT INTO prepared_outputs VALUES ('evidence:partial', 'evidence', '["rev-2"]',
      'm1', '{}', '{"coordinate_version":"synthetic-verses/1","unit_ids":["Gen.1.1"]}', '{}');
    INSERT INTO coverage VALUES ('evidence:partial', 'rev-2',
      '{"unit_ids":["Gen.1.1"]}', 'source_context', 'partial', 'm1', NULL, '[]', 'synthetic');
  `);
  const partly = [
    ...(await outputs(w.db, ['evidence:partial'])),
    ...same.filter(item => item.kind !== 'evidence'),
  ];
  assert.match(
    await problems(old, partly),
    /does not give.* source_context for 1 unit\(s\) of it, in Gen, first Gen\.1\.1/,
  );
});
