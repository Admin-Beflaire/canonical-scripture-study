import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {canonicalJson} from '../../services/maintenance/control/src/d1.ts';
import {
  ADMISSION_RULE,
  ALREADY_OBTAINED,
  SEND_IN_ORDER,
} from '../../services/maintenance/control/src/guidance.ts';
import {controlServer} from '../../services/maintenance/control/src/mcp.ts';
import {recipeInputs} from '../../services/maintenance/control/src/recipe-inputs.ts';
import {validateMembers} from '../../services/maintenance/control/src/release-check.ts';
import {callTool} from '../shared/mcp-call.ts';
import {localD1} from './d1.ts';
import {
  bucket,
  committed,
  fetched,
  reader,
  recipeFile,
  recipeNames,
  saveSource,
  stated,
  type Files,
} from './sources.ts';

const owner = 'owner@example.invalid';
const SNG = [
  'stepbible-fetch-tahot-job-sng',
  'stepbible-tahot-sng',
  'stepbible-tahot-sng-reader',
];
const AIDS = ['stepdata-tbesg-5de0a47f', 'language-aids-tbesg'];

interface Decision {
  kind: string;
  subject?: string;
  question: string;
}
interface Ready {
  steps: string[];
  constraints: Record<string, string>;
  inputs: {kind: string; id: string}[];
}

/** Control over these committed recipes, an empty database and an empty bucket. */
function world(...names: string[]) {
  const files = committed(...names);
  const db = localD1();
  const {stored, objects} = bucket();
  const {server, github} = reader(files);
  const handler = protocolHandler(
    () => controlServer(db, owner, false, github, objects),
    false,
  );
  const ask = (args: Record<string, unknown>) =>
    callTool(handler, 'get_recipe', args);
  /** Send a request as the answer gave it, with the owner's decisions it asked for. */
  const send = (key: string, request: Ready, decisions: Decision[] = []) =>
    callTool(handler, 'request_task', {
      ...request,
      request_key: key.slice(0, 100),
      instruction: 'Do it',
      decision_refs: decisions.map(({kind, subject}) => ({
        kind,
        subject,
        ref: 'owner-decision:1',
        ...(kind === 'statement' ? {name: 'Synthetic', version: '1'} : {}),
      })),
    });
  return {files, db, stored, objects, server, handler, ask, send};
}

const subjects = (decisions: Decision[], kind = 'admission') =>
  decisions
    .filter(item => item.kind === kind)
    .map(item => item.subject)
    .sort();

const CASES: [recipe: string, args: object, steps: string[]][] = [
  ['stepbible-fetch-tahot-job-sng', {}, ['fetch']],
  ['stepbible-tahot-sng', {}, ['fetch', 'build', 'select']],
  ['stepbible-tahot-sng', {prepare_only: true}, ['fetch', 'build']],
  ['stepdata-tbesg-5de0a47f', {}, ['fetch']],
  ['language-aids-tbesg', {}, ['fetch', 'build', 'select']],
];

for (const [recipe, args, steps] of CASES)
  test(`get_recipe ${recipe} ${JSON.stringify(args)} gives one request request_task accepts, after the decisions it lists`, async () => {
    const w = world(...SNG, ...AIDS);
    const answer = (await w.ask({recipe, ...args})).data;
    assert.equal(answer.requests.length, 1);
    const [request] = answer.requests;
    assert.deepEqual(request.steps, steps);
    assert.deepEqual(
      subjects(answer.owner_decisions),
      request.inputs.map((input: {id: string}) => input.id).sort(),
    );
    assert.ok(answer.notes.includes(ADMISSION_RULE));
    // Without the decisions, request_task asks exactly what the answer announced.
    const asked = (await w.send(`${recipe}-early`, request)).data;
    assert.equal(asked.status, 'needs_information');
    assert.equal(asked.missing.length, answer.owner_decisions.length);
    const sent = await w.send(recipe, request, answer.owner_decisions);
    assert.equal(sent.data.status, 'created', sent.text);
    assert.deepEqual(sent.data.limitations ?? [], []);
    await w.handler.close();
  });

test('a kept original gets no fetch, also inside a shared source revision; a missing one is fetched without a new admission', async () => {
  const w = world(...SNG);
  fetched(w.db, w.stored, w.files, 'stepbible-fetch-tahot-job-sng');
  const kept = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(kept.requests[0].steps, ['build', 'select']);
  assert.equal(kept.requests[0].constraints.fetch_recipe, undefined);
  assert.deepEqual(kept.owner_decisions, []);
  const sent = await w.send('kept', kept.requests[0]);
  assert.equal(sent.data.status, 'created', sent.text);

  const fetch = (await w.ask({recipe: 'stepbible-fetch-tahot-job-sng'})).data;
  assert.deepEqual(fetch.requests, []);
  assert.deepEqual(fetch.notes, [ALREADY_OBTAINED]);

  w.stored.clear();
  const missing = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(missing.requests[0].steps, ['fetch', 'build', 'select']);
  assert.deepEqual(missing.owner_decisions, []);
  const refetch = (await w.ask({recipe: 'stepbible-fetch-tahot-job-sng'})).data;
  assert.deepEqual(refetch.requests[0].steps, ['fetch']);
  await w.handler.close();
});

test('another kept file of the same source, or a stored file without its record, does not stand in', async () => {
  const w = world(...SNG, 'stepbible-fetch-tahot-gen-deu');
  fetched(w.db, w.stored, w.files, 'stepbible-fetch-tahot-gen-deu');
  const other = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.equal(
    other.requests[0].constraints.fetch_recipe,
    'stepbible-fetch-tahot-job-sng',
  );
  // The shared revision is admitted already; only the new file's route is asked.
  assert.deepEqual(subjects(other.owner_decisions), [
    'stepbible-data:5de0a47f35f0:tahot-job-sng',
  ]);
  const source = stated(w.files, 'stepbible-fetch-tahot-job-sng');
  w.stored.set(
    `originals/${source.revision}/${source.digest}/${source.file}`,
    source.size,
  );
  const unrecorded = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(unrecorded.requests[0].steps, ['fetch', 'build', 'select']);
  await w.handler.close();
});

test('the recipes of one book are named together, reader references first; equal ones are alternatives', async () => {
  const w = world(...SNG);
  const order = ['stepbible-tahot-sng-reader', 'stepbible-tahot-sng'];
  for (const recipe of order) {
    const answer = (await w.ask({recipe})).data;
    assert.deepEqual(answer.run_order, order, recipe);
    assert.equal(answer.alternatives, undefined);
  }
  w.server.recipes.set('collection/recipes/stepbible-tahot-sng-other.json', {
    ...recipeFile(w.files, 'stepbible-tahot-sng'),
    id: 'stepbible-tahot-sng-other',
  });
  const twice = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(twice.alternatives, ['stepbible-tahot-sng-other']);
  assert.deepEqual(twice.run_order, order);
  assert.ok(twice.notes.some((note: string) => note.includes('which one')));
  await w.handler.close();
});

test('an exclusion over a source of the build is listed, and the release check agrees', async () => {
  const w = world(...SNG);
  const source = fetched(
    w.db,
    w.stored,
    w.files,
    'stepbible-fetch-tahot-job-sng',
  );
  const first = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  await w.send('first', first.requests[0]);
  w.db.sqlite.exec(
    `INSERT INTO maintenance_exclusions SELECT 'tahot-job-sng', 'owner-decision:0', id, 1, 1 FROM maintenance_tasks`,
  );
  const answer = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(subjects(answer.owner_decisions, 'exclusion'), [
    'tahot-job-sng',
  ]);
  const output = {
    id: 'o',
    kind: 'evidence',
    revisions: [source.revision],
    extent: {},
    dependencies: [],
  };
  const excluded = async (lifted = new Set<string>()) =>
    (
      await validateMembers(w.db, new Map(), [output], {lifted})
    ).problems.filter(problem => problem.includes('excluded by the owner'));
  assert.equal((await excluded()).length, 1);
  assert.deepEqual(await excluded(new Set(['tahot-job-sng'])), []);
  await w.handler.close();
});

test('a statement build asks which name and version the owner approves', async () => {
  const w = world(
    ...recipeNames().filter(name => name.includes('character-statement')),
  );
  const answer = (await w.ask({recipe: 'character-statement-0-2'})).data;
  assert.deepEqual(
    answer.owner_decisions
      .map((item: Decision) => item.kind)
      .filter((kind: string) => kind === 'statement'),
    ['statement'],
  );
  await w.handler.close();
});

/** The build recipes of the repository grouped by the original they read and their extent. */
function families(files: Files, names: string[]) {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const recipe = recipeFile(files, name);
    if (recipe.units.every(unit => unit.kind === 'acquire')) continue;
    const inputs = recipeInputs(recipe);
    const read = inputs.filter(input => input.kind === 'acquisition');
    const key = canonicalJson([
      (read.length ? read : inputs).map(input => input.id).sort(),
      recipe.native_extent ?? {},
    ]);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  const together = new Map<string, string[]>();
  for (const group of groups.values()) {
    const sorted = [...group].sort();
    for (const name of group) together.set(name, sorted);
  }
  return together;
}

test('every committed recipe answers with requests Control does not block, naming its whole family', async () => {
  const names = recipeNames();
  const w = world(...names);
  const together = families(w.files, names);
  const problems: string[] = [];
  for (const recipe of names) {
    const answer = (await w.ask({recipe})).data;
    if (!answer.found || answer.requests.length !== 1) {
      problems.push(`${recipe}: ${JSON.stringify(answer)}`);
      continue;
    }
    const family = together.get(recipe) ?? [recipe];
    const named = [...(answer.run_order ?? [recipe])].sort();
    if (canonicalJson(named) !== canonicalJson(family))
      problems.push(`${recipe}: names ${named}, belongs with ${family}`);
    const sent = await w.send(
      recipe,
      answer.requests[0],
      answer.owner_decisions,
    );
    if (sent.data.status !== 'created' || sent.data.limitations?.length)
      problems.push(`${recipe}: ${sent.text}`);
  }
  assert.deepEqual(problems, []);
  await w.handler.close();
});

test('get_recipe refuses what is not a recipe on main, and sends nothing when no fetch recipe lists a needed original', async () => {
  const w = world('stepbible-tahot-sng');
  const missing = await w.ask({recipe: 'nothing-here'});
  assert.equal(missing.result.isError, true);
  assert.match(missing.text, /not on main/);
  const build = (await w.ask({recipe: 'stepbible-tahot-sng'})).data;
  assert.deepEqual(build.requests, []);
  assert.deepEqual(build.owner_decisions, []);
  assert.match(build.notes.join(' '), /No fetch recipe .* ask the owner/);
  assert.ok(!build.notes.includes(SEND_IN_ORDER));
  await w.handler.close();
});

/** Make these coverage rows the current release. */
function currentRelease(
  db: ReturnType<typeof localD1>,
  rows: [
    revision: string,
    capability: string,
    units: string[],
    state?: string,
  ][],
  member: (index: number) => boolean = () => true,
) {
  db.sqlite.exec(
    `INSERT INTO releases VALUES ('now', 'm', 'r', '{}', 'c', 'q', 's')`,
  );
  rows.forEach(([revision, capability, units, state = 'available'], index) => {
    saveSource(db, revision, {});
    db.sqlite
      .prepare(
        `INSERT INTO prepared_outputs VALUES (?, 'evidence', ?, 'm', '{}', '{}', '{}')`,
      )
      .run(`o${index}`, JSON.stringify([revision]));
    if (member(index))
      db.sqlite.exec(`INSERT INTO release_outputs VALUES ('now', 'o${index}')`);
    db.sqlite
      .prepare(
        `INSERT INTO coverage VALUES (?, ?, ?, ?, ?, 'm', NULL, '[]', ?)`,
      )
      .run(
        `o${index}`,
        revision,
        JSON.stringify(units.length ? {unit_ids: units} : {}),
        capability,
        state,
        state === 'available' ? null : 'synthetic',
      );
  });
  // Membership is fixed once selected, so the release is selected last.
  db.sqlite.exec(`UPDATE release_selection SET current_release_id = 'now'`);
}

test('find lists what current data holds from each matching source revision', async () => {
  const w = world('stepbible-tahot-sng');
  currentRelease(
    w.db,
    [
      ['text:1', 'source_context', ['Gen.1.1', 'Gen.1.2']],
      ['text:1', 'word_exact', ['Gen.1.1', 'Gen.1.2']],
      ['text:1', 'source_context', ['Exo.1.1']],
      ['text:1', 'reader_reference', ['Gen.1.1']],
      ['text:1', 'lemma_exact', ['Lev.1.1'], 'partial'],
      ['aids:1', 'lexicon_entry', []],
      ['text:old', 'source_context', ['Num.1.1']],
    ],
    index => index !== 6,
  );
  const answer = (await w.ask({find: 'TEXT'})).data;
  assert.deepEqual(answer.current_sources, [
    {
      source_revision: 'text:1',
      holds: [
        {capabilities: ['reader_reference'], units: 1, parts: ['Gen']},
        {capabilities: ['source_context'], units: 3, parts: ['Exo', 'Gen']},
        {capabilities: ['word_exact'], units: 2, parts: ['Gen']},
      ],
    },
  ]);
  assert.equal(answer.next_sources_after, undefined);
  const aids = (await w.ask({find: 'aids'})).data;
  assert.deepEqual(aids.current_sources[0].holds, [
    {capabilities: ['lexicon_entry'], units: 0, parts: []},
  ]);
  assert.equal((await w.ask({})).data.current_sources, undefined);
  await w.handler.close();
});

test('current sources come in bounded pages', async () => {
  const w = world('stepbible-tahot-sng');
  const revisions = Array.from(
    {length: 12},
    (_, index) => `many:${String(index).padStart(2, '0')}`,
  );
  currentRelease(
    w.db,
    revisions.map(revision => [revision, 'source_context', ['Gen.1.1']]),
  );
  const first = (await w.ask({find: 'many'})).data;
  const rest = (
    await w.ask({find: 'many', sources_after: first.next_sources_after})
  ).data;
  assert.deepEqual(
    [...first.current_sources, ...rest.current_sources].map(
      item => item.source_revision,
    ),
    revisions,
  );
  assert.equal(first.current_sources.length, 10);
  assert.equal(rest.next_sources_after, undefined);
  await w.handler.close();
});

test('get_recipe lists recipes by word, and reports an unreachable GitHub plainly', async () => {
  const w = world(...SNG, ...AIDS);
  const listed = (await w.ask({find: 'SNG'})).data;
  assert.deepEqual(listed.recipes, [...SNG].sort());
  w.server.state.down = true;
  for (const args of [{}, {recipe: 'stepbible-tahot-sng'}]) {
    const answer = await w.ask(args);
    assert.equal(answer.result.isError, true);
    assert.match(answer.text, /GitHub did not answer/);
  }
  await w.handler.close();
});
