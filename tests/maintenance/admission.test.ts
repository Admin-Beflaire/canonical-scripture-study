import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionDoubt} from '../../services/maintenance/control/src/admission.ts';
import type {InputRef} from '../../services/maintenance/control/src/contracts.ts';
import {recipeInputs} from '../../services/maintenance/control/src/recipe-inputs.ts';
import {requestTask} from '../../services/maintenance/control/src/tasks.ts';
import {localD1} from './d1.ts';
import {
  bucket,
  committed,
  fetched,
  manifestFile,
  reader,
  recipeFile,
  recipeNames,
  type Files,
} from './sources.ts';

// A real route that pins no digest, and a real pinned STEPBible file.
const UNPINNED = 'sblgnt-d7f35adca9ec';
const PINNED = 'stepbible-fetch-tagnt-act-rev';
const SIBLING = 'stepbible-fetch-tagnt-mat-jhn';
const OTHER = 'e'.repeat(64);

/** A database, bucket and repository after the named recipe's original was fetched. */
function world(name: string, ...more: string[]) {
  const files = committed(name, ...more);
  const db = localD1();
  const {stored, objects} = bucket();
  const source = fetched(db, stored, files, name);
  const {server, github} = reader(files);
  const [input] = inputsOf(files, name);
  const doubt = (of = input) =>
    admissionDoubt(db, {github, objects}, of, [name]);
  return {files, db, stored, objects, github, server, source, input, doubt};
}
type World = ReturnType<typeof world>;

const inputsOf = (files: Files, name: string): InputRef[] =>
  recipeInputs(recipeFile(files, name));

const fetchRequest = (w: World, name: string, key = 'k') => ({
  request_key: key,
  instruction: 'Fetch it again',
  steps: ['fetch' as const],
  inputs: inputsOf(w.files, name),
  extent: recipeFile(w.files, name).native_extent,
  constraints: {fetch_recipe: name},
});

for (const name of [UNPINNED, PINNED])
  test(`${name}: an admitted input is not asked again, also after a recipe change`, async () => {
    const w = world(name);
    const sources = {github: w.github, objects: w.objects};
    const first = await requestTask(
      w.db,
      'owner',
      fetchRequest(w, name),
      sources,
    );
    assert.equal(first.status, 'created', JSON.stringify(first));
    recipeFile(w.files, name).revision += '-changed';
    const later = await requestTask(
      w.db,
      'owner',
      fetchRequest(w, name, 'k2'),
      sources,
    );
    assert.equal(later.status, 'created', JSON.stringify(later));
  });

for (const name of [UNPINNED, PINNED])
  test(`${name}: a missing original whose admitted bytes are fixed is not asked`, async () => {
    const w = world(name);
    w.stored.clear();
    assert.equal(await w.doubt(), null);
  });

test('every committed fetch recipe states an original that an admitted fetch matches', async () => {
  const names = recipeNames().filter(name =>
    recipeFile(committed(name), name).units.every(
      unit => unit.kind === 'acquire',
    ),
  );
  assert.ok(names.length > 20);
  for (const name of names) assert.equal(await world(name).doubt(), null, name);
});

const manifestOf = (w: World) => manifestFile(w.files, UNPINNED);
const pin = (w: World) => recipeFile(w.files, PINNED).parameters;
const column = (w: World, name: string, value: string | number) =>
  w.db.sqlite.prepare(`UPDATE admissions SET ${name} = ?`).run(value);

/** One change after an admitted fetch, and the reason the owner is then asked. */
const ASKED: [string, string, (w: World) => void, RegExp][] = [
  [
    'a changed digest on the same route, original kept',
    PINNED,
    w => (pin(w).sha256 = OTHER),
    /another digest/,
  ],
  [
    'a manifest that now pins another digest than recorded',
    UNPINNED,
    w => (manifestOf(w).expected_sha256 = OTHER),
    /another digest/,
  ],
  [
    'another stored digest beside the recorded one',
    UNPINNED,
    w => w.stored.set(`originals/${w.source.revision}/${OTHER}/original`, 7),
    /another digest/,
  ],
  [
    'a stored copy of another size',
    UNPINNED,
    w => w.stored.set(w.source.key, 8),
    /recorded size/,
  ],
  [
    'eligibility',
    UNPINNED,
    w => column(w, 'both_hosts_eligible', 0),
    /not eligible/,
  ],
  [
    'terms',
    UNPINNED,
    w => (manifestOf(w).admission_record.terms_basis = 'new terms'),
    /other terms_basis/,
  ],
  [
    'permitted uses',
    UNPINNED,
    w => column(w, 'permitted_uses_json', '["acquire"]'),
    /other permitted_uses/,
  ],
  [
    'restrictions',
    PINNED,
    w => pin(w).admission_record!.restrictions.push('A new restriction'),
    /other restrictions/,
  ],
  ['notices', PINNED, w => column(w, 'notices_json', '[]'), /other notices/],
  [
    'public redistribution',
    UNPINNED,
    w => column(w, 'public_redistribution', 'not_allowed'),
    /other public_redistribution/,
  ],
  [
    'another address',
    UNPINNED,
    w => (manifestOf(w).url += '?v=2'),
    /route differs/,
  ],
  [
    'nothing recorded for the original',
    UNPINNED,
    w => w.db.sqlite.exec(`UPDATE source_nodes SET details_json = '{}'`),
    /route differs/,
  ],
  [
    'a missing original of which no size was recorded',
    UNPINNED,
    w => {
      w.stored.clear();
      w.db.sqlite.exec(
        `UPDATE source_nodes SET details_json = json_remove(details_json, '$.byte_count')`,
      );
    },
    /records do not show which bytes/,
  ],
  [
    'a missing original that no digest pins',
    PINNED,
    w => {
      w.stored.clear();
      delete pin(w).sha256;
    },
    /records do not show which bytes/,
  ],
  [
    'storage that cannot be listed',
    PINNED,
    w => (w.objects.list = async () => ({objects: [], cursor: 'more'})),
    /storage cannot show/,
  ],
  [
    'a recipe that states no record',
    PINNED,
    w => delete pin(w).admission_record,
    /states no admission record/,
  ],
  [
    'GitHub not answering',
    PINNED,
    w => (w.server.state.down = true),
    /GitHub did not answer/,
  ],
];
test('what no recorded admission covers is asked, with the reason', async () => {
  for (const [what, name, change, reason] of ASKED) {
    const w = world(name);
    change(w);
    assert.match((await w.doubt()) ?? 'not asked', reason, what);
  }
});

test('another component of an admitted revision, other stated bytes and no reader are asked', async () => {
  const w = world(PINNED, SIBLING);
  const [sibling] = inputsOf(w.files, SIBLING);
  assert.match(
    (await w.doubt(sibling))!,
    /no admission is recorded for this source revision and component/,
  );
  assert.match(
    (await w.doubt({...w.input, sha256: OTHER}))!,
    /other bytes than the recipe pins/,
  );
  assert.match(
    (await admissionDoubt(w.db, {github: null, objects: null}, w.input))!,
    /cannot read the recipe/,
  );
  const asked = await requestTask(w.db, 'owner', fetchRequest(w, SIBLING), {
    github: w.github,
    objects: w.objects,
  });
  assert.ok(asked.status === 'needs_information');
  assert.deepEqual(
    asked.missing.map(item => item.includes(sibling.id)),
    [true],
  );
});
