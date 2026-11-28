import {admissionDoubt} from './admission.ts';
import type {Recipe} from './contracts.ts';
import {canonicalJson, type D1Database} from './d1.ts';
import type {RecipeFiles} from './github.ts';
import {
  ADMISSION_RULE,
  ALREADY_OBTAINED,
  ANALYSIS_REPORT,
  SEND_IN_ORDER,
  admissionQuestion,
  alternativesNote,
  exclusionQuestion,
  runOrderNote,
  STATEMENT_QUESTION,
  unlistedNote,
} from './guidance.ts';
import {
  findFetchRecipe,
  originalState,
  readOriginal,
  type FetchRecipe,
} from './originals.ts';
import {originalRecorded} from './progress.ts';
import {loadRecipe} from './recipe-load.ts';
import {
  fetchesOnly,
  recipeInputs,
  sameInput,
  type RecipeInput,
} from './recipe-inputs.ts';
import {
  activeExclusions,
  relatedIds,
  type ObjectStore,
} from './release-check.ts';
import type {Step} from './tasks.ts';

/** What a recipe needs, as requests ready to send and the decisions to ask first, so nobody has
 *  to read code or designs and there is no choice between variants. */

const PAGE = 50;
const SIBLINGS = 6;

export interface GuideSources {
  db: D1Database;
  github: RecipeFiles;
  objects: ObjectStore | null;
}

interface ReadyRequest {
  steps: Step[];
  constraints: {recipe?: string; fetch_recipe?: string};
  extent: Record<string, unknown>;
  capabilities: string[];
  inputs: RecipeInput[];
}

interface OwnerDecision {
  kind: 'admission' | 'exclusion' | 'statement';
  subject?: string;
  question: string;
}

/** The inputs that name the original a build reads: its file's acquisition, else its source revision.
 *  A source revision shared by several files says nothing about one file, so it is not used then. */
function originals(inputs: RecipeInput[]): RecipeInput[] {
  const acquisitions = inputs.filter(input => input.kind === 'acquisition');
  return acquisitions.length
    ? acquisitions
    : inputs.filter(input => input.kind === 'source_revision');
}

const fetchRequest = (id: string, recipe: Recipe): ReadyRequest => ({
  steps: ['fetch'],
  constraints: {fetch_recipe: id},
  extent: recipe.native_extent ?? {},
  capabilities: [],
  inputs: recipeInputs(recipe),
});

/** The build, after the fetches it needs: one fetch joins it in one task; several go first. */
function buildRequests(
  id: string,
  recipe: Recipe,
  fetches: FetchRecipe[],
  select: boolean,
): ReadyRequest[] {
  const build: ReadyRequest = {
    steps: select ? ['build', 'select'] : ['build'],
    constraints: {recipe: id},
    extent: recipe.native_extent ?? {},
    capabilities: recipe.capabilities ?? [],
    inputs: recipeInputs(recipe),
  };
  if (fetches.length !== 1)
    return [...fetches.map(item => fetchRequest(item.id, item.recipe)), build];
  const [only] = fetches;
  return [
    {
      ...build,
      steps: ['fetch', ...build.steps],
      constraints: {fetch_recipe: only.id, recipe: id},
      inputs: [...recipeInputs(only.recipe), ...build.inputs].filter(
        (input, at, all) =>
          all.findIndex(item => sameInput(item, input)) === at,
      ),
    },
  ];
}

async function stateOf({db, github, objects}: GuideSources, recipe: Recipe) {
  const original = await readOriginal(github, recipe);
  return original ? originalState(db, objects, original) : null;
}

/** The fetches a build needs, one per original that is not kept and recorded, and the originals
 *  no fetch recipe lists. */
async function neededFetches(sources: GuideSources, recipe: Recipe) {
  const fetches: FetchRecipe[] = [];
  const unlisted: RecipeInput[] = [];
  for (const input of originals(recipeInputs(recipe))) {
    const found = await findFetchRecipe(sources.github, input);
    if (found) {
      const state = await stateOf(sources, found.recipe);
      if (
        !(state?.kept && state.recorded) &&
        !fetches.some(item => item.id === found.id)
      )
        fetches.push(found);
    } else if (
      input.kind !== 'source_revision' ||
      !(await originalRecorded(sources.db, input.id))
    )
      unlisted.push(input);
  }
  return {fetches, unlisted};
}

const readsAndCovers = (recipe: Recipe) =>
  canonicalJson([
    originals(recipeInputs(recipe))
      .map(input => `${input.kind} ${input.id}`)
      .sort(),
    recipe.native_extent ?? {},
  ]);
const gives = (recipe: Recipe) =>
  canonicalJson([...(recipe.capabilities ?? [])].sort());
/** Reader references first, so a new book is not selected for reader lookup without them. */
const readerFirst = (recipe: Recipe) =>
  recipe.capabilities?.includes('reader_reference') ? 0 : 1;

/** The build recipes over the same original and extent. Candidates are the IDs that start with
 *  this recipe's name; only their own files make them belong. Other capabilities are run in
 *  order; the same capabilities are alternatives. */
async function relatedRecipes(github: RecipeFiles, id: string, recipe: Recipe) {
  const stem = id.replace(/-reader$/, '');
  const names = (await github.listRecipes())
    .filter(
      name => name !== id && (name === stem || name.startsWith(`${stem}-`)),
    )
    .sort()
    .slice(0, SIBLINGS);
  const together = [{id, recipe}];
  const alternatives: string[] = [];
  for (const name of names) {
    const other = (await loadRecipe(github, name)).recipe;
    if (
      !other ||
      fetchesOnly(other) ||
      readsAndCovers(other) !== readsAndCovers(recipe)
    )
      continue;
    if (gives(other) === gives(recipe)) alternatives.push(name);
    else together.push({id: name, recipe: other});
  }
  const runOrder = together
    .sort(
      (a, b) =>
        readerFirst(a.recipe) - readerFirst(b.recipe) ||
        a.id.localeCompare(b.id),
    )
    .map(item => item.id);
  return {runOrder, alternatives};
}

/** The inputs request_task will ask an admission decision for; an input an earlier request
 *  lists is decided there. */
async function admissionDecisions(
  sources: GuideSources,
  requests: ReadyRequest[],
): Promise<OwnerDecision[]> {
  const seen: RecipeInput[] = [];
  const decisions: OwnerDecision[] = [];
  for (const {constraints, inputs} of requests)
    for (const input of inputs) {
      if (seen.some(item => sameInput(item, input))) continue;
      seen.push(input);
      const why = await admissionDoubt(
        sources.db,
        sources,
        input,
        [constraints.fetch_recipe, constraints.recipe].filter(
          item => item !== undefined,
        ),
      );
      if (why)
        decisions.push({
          kind: 'admission',
          subject: input.id,
          question: admissionQuestion(input.id, why),
        });
    }
  return decisions;
}

/** The active exclusions that cover a source of the build, as the release check finds them. */
async function exclusionDecisions(
  db: D1Database,
  recipe: Recipe,
): Promise<OwnerDecision[]> {
  const revisions = recipeInputs(recipe)
    .filter(input => input.kind === 'source_revision')
    .map(input => input.id);
  const related = await relatedIds(db, revisions);
  const active = await activeExclusions(db);
  const covered = [...related.values()].flatMap(ids => [...ids]);
  return [...new Set(covered.filter(id => active.includes(id)))].map(id => ({
    kind: 'exclusion',
    subject: id,
    question: exclusionQuestion(id),
  }));
}

async function describeFetch(
  sources: GuideSources,
  id: string,
  recipe: Recipe,
) {
  const state = await stateOf(sources, recipe);
  const requests = state?.kept && !state.asks ? [] : [fetchRequest(id, recipe)];
  const decisions = await admissionDecisions(sources, requests);
  return {
    found: true as const,
    recipe: id,
    does: 'fetch' as const,
    requests,
    owner_decisions: decisions,
    notes: [
      ...(requests.length ? [] : [ALREADY_OBTAINED]),
      ...(decisions.length ? [ADMISSION_RULE] : []),
    ],
  };
}

async function describeAnalysis(
  sources: GuideSources,
  id: string,
  recipe: Recipe,
) {
  const state = await stateOf(sources, recipe);
  if (!state)
    return {
      found: false as const,
      message: 'The fetch recipe does not identify an original to analyse.',
    };
  const request = fetchRequest(id, recipe);
  request.steps =
    state.kept && state.recorded && !state.asks
      ? ['analyse']
      : ['fetch', 'analyse'];
  const decisions = await admissionDecisions(sources, [request]);
  return {
    found: true as const,
    recipe: id,
    does: 'analyse' as const,
    requests: [request],
    owner_decisions: decisions,
    notes: [ANALYSIS_REPORT, ...(decisions.length ? [ADMISSION_RULE] : [])],
  };
}

async function describeBuild(
  sources: GuideSources,
  id: string,
  recipe: Recipe,
  select: boolean,
) {
  const {fetches, unlisted} = await neededFetches(sources, recipe);
  const requests = unlisted.length
    ? []
    : buildRequests(id, recipe, fetches, select);
  const {runOrder, alternatives} = await relatedRecipes(
    sources.github,
    id,
    recipe,
  );
  const admissions = await admissionDecisions(sources, requests);
  const decisions: OwnerDecision[] = requests.length
    ? [
        ...admissions,
        ...(await exclusionDecisions(sources.db, recipe)),
        ...(recipe.capabilities?.includes('character_statement')
          ? [{kind: 'statement' as const, question: STATEMENT_QUESTION}]
          : []),
      ]
    : [];
  return {
    found: true as const,
    recipe: id,
    does: 'build' as const,
    requests,
    owner_decisions: decisions,
    ...(runOrder.length > 1 ? {run_order: runOrder} : {}),
    ...(alternatives.length ? {alternatives} : {}),
    notes: [
      ...unlisted.map(input => unlistedNote(input.kind, input.id)),
      ...(requests.length > 1 ? [SEND_IN_ORDER] : []),
      ...(runOrder.length > 1 ? [runOrderNote(runOrder)] : []),
      ...(alternatives.length ? [alternativesNote(id, alternatives)] : []),
      ...(admissions.length ? [ADMISSION_RULE] : []),
    ],
  };
}

export async function describeRecipe(
  sources: GuideSources,
  id: string,
  prepareOnly = false,
  analyse = false,
) {
  const {recipe, problem} = await loadRecipe(sources.github, id);
  if (!recipe) return {found: false as const, message: problem!};
  if (analyse)
    return fetchesOnly(recipe)
      ? describeAnalysis(sources, id, recipe)
      : {
          found: false as const,
          message: 'Use analyse with the source’s fetch recipe.',
        };
  return fetchesOnly(recipe)
    ? describeFetch(sources, id, recipe)
    : describeBuild(sources, id, recipe, !prepareOnly);
}

/** Recipe IDs on main, optionally those containing a word, a bounded page. */
export async function findRecipes(github: RecipeFiles, find?: string) {
  const word = find?.toLowerCase();
  const matching = (await github.listRecipes())
    .filter(name => !word || name.toLowerCase().includes(word))
    .sort();
  return {
    recipes: matching.slice(0, PAGE),
    more: Math.max(0, matching.length - PAGE),
  };
}
