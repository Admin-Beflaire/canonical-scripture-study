import type {Recipe} from './contracts.ts';
import type {D1Database} from './d1.ts';
import type {GitHubActions} from './github.ts';
import {ADMISSION_RULE} from './guidance.ts';
import {originalRecorded} from './progress.ts';
import {loadRecipe} from './recipe-load.ts';
import {fetchesOnly, recipeInputs, type RecipeInput} from './recipe-inputs.ts';

const PAGE = 50;
const CANDIDATES = 6;

interface TaskRequest {
  steps: string[];
  constraints: Record<string, string>;
  extent: Record<string, unknown>;
  capabilities: string[];
  inputs: RecipeInput[];
}

const same = (a: RecipeInput, b: RecipeInput) =>
  a.kind === b.kind && a.id === b.id;

/** The inputs that name the original a build reads: its file's acquisition, else its source revision.
 *  A source revision shared by several files says nothing about one file, so it is not used then. */
function originals(inputs: RecipeInput[]): RecipeInput[] {
  const acquisitions = inputs.filter(input => input.kind === 'acquisition');
  return acquisitions.length
    ? acquisitions
    : inputs.filter(input => input.kind === 'source_revision');
}

/** The fetch recipe that keeps this original: candidates are the recipe IDs holding the input's own
 *  name, and only one that lists the same input is accepted, so nothing is guessed. */
async function fetchRecipeFor(
  github: GitHubActions,
  names: string[],
  input: RecipeInput,
): Promise<{id: string; recipe: Recipe} | undefined> {
  const key = input.id.split(':').pop()!.split('/')[0];
  for (const id of names
    .filter(name => name.includes(key))
    .slice(0, CANDIDATES)) {
    const {recipe} = await loadRecipe(github, id);
    if (
      recipe &&
      fetchesOnly(recipe) &&
      recipeInputs(recipe).some(item => same(item, input))
    )
      return {id, recipe};
  }
  return undefined;
}

/** What a build needs fetched first, per original: the fetch recipe, and for a source revision of
 *  its own whether its original is already kept (a file inside a shared revision cannot be seen here). */
async function missingOriginals(
  db: D1Database,
  github: GitHubActions,
  inputs: RecipeInput[],
) {
  const names = (await github.listRecipes()).sort();
  const missing: {input: RecipeInput; fetch?: {id: string; recipe: Recipe}}[] =
    [];
  for (const input of originals(inputs)) {
    if (
      input.kind === 'source_revision' &&
      (await originalRecorded(db, input.id))
    )
      continue;
    missing.push({input, fetch: await fetchRecipeFor(github, names, input)});
  }
  return missing;
}

/** What a recipe needs, as a request ready to send, so nobody has to read code or designs. */
export async function describeRecipe(
  db: D1Database,
  github: GitHubActions,
  id: string,
) {
  const {recipe, problem} = await loadRecipe(github, id);
  if (!recipe) return {found: false as const, message: problem!};
  const fetches = fetchesOnly(recipe);
  const inputs = recipeInputs(recipe);
  const notes = [
    `Each input needs an owner admission decision (kind "admission", subject the input id) unless request_task says it is already admitted. ${ADMISSION_RULE}`,
  ];
  const request: TaskRequest = {
    steps: fetches ? ['fetch'] : ['build'],
    constraints: fetches ? {fetch_recipe: id} : {recipe: id},
    extent: recipe.native_extent ?? {},
    capabilities: fetches ? [] : (recipe.capabilities ?? []),
    inputs,
  };
  let withFetch: TaskRequest | undefined;
  if (!fetches) {
    notes.push(
      'To make the build current in the same task use steps ["build","select"].',
    );
    const missing = await missingOriginals(db, github, inputs);
    const found = missing.filter(item => item.fetch);
    for (const item of missing.filter(item => !item.fetch))
      notes.push(
        `No fetch recipe on main lists ${item.input.kind} ${item.input.id}; ask the owner how that original is obtained.`,
      );
    if (found.length === 1 && missing.length === 1) {
      const {id: fetchId, recipe: fetchRecipe} = found[0].fetch!;
      const merged = [...recipeInputs(fetchRecipe), ...inputs].filter(
        (input, at, all) => all.findIndex(item => same(item, input)) === at,
      );
      withFetch = {
        steps: ['fetch', 'build'],
        constraints: {fetch_recipe: fetchId, recipe: id},
        extent: request.extent,
        capabilities: request.capabilities,
        inputs: merged,
      };
      notes.push(
        `This build reads an original that fetch recipe ${fetchId} keeps. If you do not know that it was fetched, send request_with_fetch: one task fetches first and then builds (fetching again is safe); otherwise send request. Add "select" at the end of steps to make the build current.`,
      );
    } else if (found.length) {
      notes.push(
        `This build reads ${missing.length} originals; each fetch recipe keeps one: ${found.map(item => `${item.fetch!.id} (${item.input.id})`).join(', ')}. Fetch each in its own task first.`,
      );
    }
  }
  if (!inputs.length) notes.push('This recipe lists no inputs.');
  return {
    found: true as const,
    recipe: id,
    does: fetches ? 'fetch' : 'build',
    request,
    ...(withFetch ? {request_with_fetch: withFetch} : {}),
    notes,
  };
}

/** Recipe IDs on main, optionally those containing a word, a bounded page. */
export async function findRecipes(github: GitHubActions, find?: string) {
  const word = find?.toLowerCase();
  const matching = (await github.listRecipes())
    .filter(name => !word || name.toLowerCase().includes(word))
    .sort();
  return {
    recipes: matching.slice(0, PAGE),
    more: Math.max(0, matching.length - PAGE),
  };
}
