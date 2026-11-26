import type {D1Database} from './d1.ts';
import type {GitHubActions} from './github.ts';
import {loadRecipe} from './progress.ts';
import {recipeInputs} from './recipe-inputs.ts';

const PAGE = 50;

/** What a recipe needs, as a request ready to send, so nobody has to read code or designs. */
export async function describeRecipe(
  db: D1Database,
  github: GitHubActions,
  id: string,
) {
  const {recipe, problem} = await loadRecipe(github, id);
  if (!recipe) return {found: false as const, message: problem!};
  const fetches = (recipe.units ?? []).every(unit => unit.kind === 'acquire');
  const inputs = recipeInputs(recipe);
  const revision = inputs.find(input => input.kind === 'source_revision');
  const saved =
    revision &&
    !!(await db
      .prepare(
        `SELECT 1 FROM source_nodes WHERE id = ? AND kind = 'source_revision'`,
      )
      .bind(revision.id)
      .first());
  const notes = [
    'Each input needs an owner admission decision (kind "admission", subject the input id) unless request_task says it is already admitted.',
  ];
  if (!fetches)
    notes.push(
      'To make the build current in the same task use steps ["build","select"].',
    );
  if (!fetches && revision && !saved)
    notes.push(
      `The source revision ${revision.id} is not saved yet. Fetch the source first with a fetch recipe over the same file (list recipes with find "fetch").`,
    );
  if (!inputs.length) notes.push('This recipe lists no inputs.');
  return {
    found: true as const,
    recipe: id,
    does: fetches ? 'fetch' : 'build',
    request: {
      steps: fetches ? ['fetch'] : ['build'],
      constraints: fetches ? {fetch_recipe: id} : {recipe: id},
      extent: recipe.native_extent ?? {},
      capabilities: fetches ? [] : (recipe.capabilities ?? []),
      inputs,
    },
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
