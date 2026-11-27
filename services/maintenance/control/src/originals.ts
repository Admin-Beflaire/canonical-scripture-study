import type {Recipe} from './contracts.ts';
import {canonicalJson, type D1Database} from './d1.ts';
import type {RecipeFiles} from './github.ts';
import {loadRecipe} from './recipe-load.ts';
import {
  fetchesOnly,
  recipeInputs,
  sameInput,
  type RecipeInput,
} from './recipe-inputs.ts';
import type {ObjectStore} from './release-check.ts';

/** The original a fetch recipe keeps: what the reviewed recipe or its manifest states about it,
 *  and what the saved records and storage show (Maintenance Technical §4). Control reads names,
 *  sizes and records here; the bytes are verified where they are used. */

const CANDIDATES = 6;
/** The admission record's content, as a recipe or manifest states it and as it is saved. */
const FIELDS = [
  'terms_basis',
  'permitted_uses',
  'restrictions',
  'notices',
  'both_hosts_eligible',
  'public_redistribution',
] as const;
type AdmissionRecord = Record<(typeof FIELDS)[number], unknown>;

export interface Original {
  revision: string;
  component: string;
  /** The stored file's name under `originals/<revision>/<sha256>/`. */
  file: string;
  /** A fixed upstream revision and path, or an address. */
  route: {commit: string; path: string} | {url: string};
  /** The digest and size the recipe pins, where it states them. */
  digest: string | null;
  size: number | null;
  admission: AdmissionRecord;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const digestOf = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
const sizeOf = (value: unknown) =>
  typeof value === 'number' && value > 0 ? value : null;

function parsed(text: string | null): unknown {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** A STEPBible fetch recipe states its pinned file and admission record in its parameters. */
function pinnedComponent(recipe: Recipe): Original | null {
  const {commit, component, path, sha256, byte_count, admission_record} =
    recipe.parameters ?? {};
  const revision = recipe.task_inputs?.find(
    input => input.kind === 'source_revision',
  )?.id;
  if (
    !revision ||
    !isText(component) ||
    !isText(commit) ||
    !isText(path) ||
    !isObject(admission_record)
  )
    return null;
  return {
    revision,
    component,
    file: `${component}.txt`,
    route: {commit, path},
    digest: digestOf(sha256),
    size: sizeOf(byte_count),
    admission: admission_record as AdmissionRecord,
  };
}

/** An acquire-only recipe's manifest states the route and the admission record. */
async function manifestSource(
  github: RecipeFiles,
  recipe: Recipe,
): Promise<Original | null> {
  const name = recipe.parameters?.manifest;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*\.json$/.test(name))
    return null;
  const manifest = parsed(
    await github.readFile(`collection/manifests/${name}`),
  );
  if (!isObject(manifest)) return null;
  const {source_revision, url, admission_record} = manifest;
  if (
    source_revision !== recipe.native_extent?.component ||
    manifest.manifest_revision !== recipe.manifest_revision ||
    !isText(source_revision) ||
    !isText(url) ||
    !isObject(admission_record)
  )
    return null;
  return {
    revision: source_revision,
    component: 'archive',
    file: 'original',
    route: {url},
    digest: digestOf(manifest.expected_sha256),
    size: sizeOf(manifest.byte_count),
    admission: admission_record as AdmissionRecord,
  };
}

/** What a fetch recipe states about its original; null when it states no usable one. */
export async function readOriginal(
  github: RecipeFiles,
  recipe: Recipe,
): Promise<Original | null> {
  const adapter = recipe.adapter?.method_version;
  if (adapter === 'stepbible-fetch/1') return pinnedComponent(recipe);
  if (adapter === 'acquire-only/1') return manifestSource(github, recipe);
  return null;
}

export interface FetchRecipe {
  id: string;
  recipe: Recipe;
}

/** The fetch recipe that keeps this input's original: the preferred ones first, then those whose
 *  ID holds the input's own name. Only one that lists the same input is accepted. */
export async function findFetchRecipe(
  github: RecipeFiles,
  input: RecipeInput,
  preferred: string[] = [],
): Promise<FetchRecipe | undefined> {
  const lists = async (id: string) => {
    const {recipe} = await loadRecipe(github, id);
    return recipe &&
      fetchesOnly(recipe) &&
      recipeInputs(recipe).some(item => sameInput(item, input))
      ? {id, recipe}
      : undefined;
  };
  for (const id of preferred) {
    const found = await lists(id);
    if (found) return found;
  }
  const key = input.id.split(':').pop()!.split('/')[0];
  const named = (await github.listRecipes())
    .sort()
    .filter(name => name.includes(key) && !preferred.includes(name));
  for (const id of named.slice(0, CANDIDATES)) {
    const found = await lists(id);
    if (found) return found;
  }
  return undefined;
}

interface SavedAdmission {
  terms_basis: string;
  permitted_uses_json: string;
  restrictions_json: string;
  notices_json: string;
  both_hosts_eligible: number;
  public_redistribution: string;
}
/** What the source revision records about the bytes and route it was fetched with. */
interface Recorded {
  digest: string | null;
  size: number | null;
  url?: unknown;
  commit?: unknown;
}

function savedAdmission(db: D1Database, original: Original) {
  return db
    .prepare(
      `SELECT terms_basis, permitted_uses_json, restrictions_json, notices_json, both_hosts_eligible,
    public_redistribution FROM admissions WHERE source_revision_id = ? AND component = ?`,
    )
    .bind(original.revision, original.component)
    .first<SavedAdmission>();
}

async function recordedDetails(
  db: D1Database,
  revision: string,
): Promise<Recorded> {
  const row = await db
    .prepare(
      `SELECT details_json FROM source_nodes WHERE id = ? AND kind = 'source_revision'`,
    )
    .bind(revision)
    .first<{details_json: string}>();
  const value = parsed(row?.details_json ?? null);
  const details = isObject(value) ? value : {};
  return {
    digest: digestOf(details.sha256),
    size: sizeOf(details.byte_count),
    url: details.url,
    commit: details.commit,
  };
}

/** Size by digest of the stored copies of this file; one bounded listing, null if it cannot tell. */
async function storedCopies(
  objects: ObjectStore | null,
  original: Original,
): Promise<Map<string, number> | null> {
  if (!objects) return null;
  const prefix = `originals/${original.revision}/`;
  const page = await objects.list(prefix);
  if (page.cursor) return null;
  const copies = new Map<string, number>();
  for (const {key, size} of page.objects) {
    const [digest, file, ...deeper] = key.slice(prefix.length).split('/');
    if (digestOf(digest) && file === original.file && !deeper.length)
      copies.set(digest, size);
  }
  return copies;
}

/** The fields in which the saved record differs from the one the recipe states. */
function changedFields(saved: SavedAdmission, stated: AdmissionRecord) {
  const record: AdmissionRecord = {
    terms_basis: saved.terms_basis,
    permitted_uses: parsed(saved.permitted_uses_json),
    restrictions: parsed(saved.restrictions_json),
    notices: parsed(saved.notices_json),
    both_hosts_eligible: saved.both_hosts_eligible === 1,
    public_redistribution: saved.public_redistribution,
  };
  return FIELDS.filter(
    field =>
      canonicalJson(record[field]) !== canonicalJson(stated[field] ?? null),
  );
}

/** A fixed upstream revision and path is the same when the saved record names both; an address
 *  when the source revision records it. */
function sameRoute(
  original: Original,
  saved: SavedAdmission,
  recorded: Recorded,
) {
  const {route} = original;
  if ('url' in route) return recorded.url === route.url;
  return (
    saved.terms_basis.includes(route.commit) &&
    saved.terms_basis.includes(route.path) &&
    (recorded.commit === undefined || recorded.commit === route.commit)
  );
}

interface Evidence {
  original: Original;
  recorded: Recorded;
  copies: Map<string, number> | null;
  /** The digest the bytes must have: the pinned one, else the recorded one. */
  expected: string | null;
  kept: boolean;
}

/** Why the bytes cannot be taken to be the admitted ones, or null. */
function bytesDoubt({original, recorded, copies, expected, kept}: Evidence) {
  if (!copies) return 'storage cannot show which bytes are kept';
  if (!expected) return 'the records do not show which bytes were admitted';
  const other = [recorded.digest, ...copies.keys()].some(
    digest => digest && digest !== expected,
  );
  if (other)
    return 'another digest is recorded or stored for this source revision and component';
  if (kept) return null;
  if (copies.has(expected))
    return 'the stored copy does not have the recorded size';
  const fixed =
    (recorded.digest !== null && recorded.size !== null) ||
    ('commit' in original.route && original.digest !== null);
  return fixed
    ? null
    : 'the original is missing and the records do not show which bytes were admitted';
}

/** Why the saved admission no longer covers what the recipe would fetch and record, or null. */
function recordDoubt(saved: SavedAdmission | null, evidence: Evidence) {
  if (!saved)
    return 'no admission is recorded for this source revision and component';
  if (saved.both_hosts_eligible !== 1)
    return 'the recorded admission is not eligible for both hosts';
  const changed = changedFields(saved, evidence.original.admission);
  if (changed.length)
    return `the recipe states other ${changed.join(', ')} than the saved admission`;
  if (!sameRoute(evidence.original, saved, evidence.recorded))
    return 'the route differs from the recorded one';
  return bytesDoubt(evidence);
}

export interface OriginalState {
  /** Storage holds the file under the expected digest and size: nothing needs downloading. */
  kept: boolean;
  /** The source revision and this component's admission are saved. */
  recorded: boolean;
  /** Why the owner must decide on admission, or null when the recorded admission applies. */
  asks: string | null;
}

/** What the records and storage show about one original. */
export async function originalState(
  db: D1Database,
  objects: ObjectStore | null,
  original: Original,
): Promise<OriginalState> {
  const saved = await savedAdmission(db, original);
  const recorded = await recordedDetails(db, original.revision);
  const copies = await storedCopies(objects, original);
  const expected = original.digest ?? recorded.digest;
  const size = original.digest ? original.size : recorded.size;
  const found = expected ? copies?.get(expected) : undefined;
  const kept = found !== undefined && (size === null || found === size);
  return {
    kept,
    recorded: !!saved,
    asks: recordDoubt(saved, {original, recorded, copies, expected, kept}),
  };
}
