import {recipeErrors, type Recipe} from './contracts.ts';
import {FileEncodingError, type GitHubActions} from './github.ts';

/** Read and check the recipe named in the task, from reviewed main. */
export async function loadRecipe(
  github: GitHubActions,
  id: unknown,
): Promise<{recipe?: Recipe; problem?: string}> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(id))
    return {problem: 'constraints.recipe must name a reviewed recipe'};
  let text: string | null;
  try {
    text = await github.readFile(`collection/recipes/${id}.json`);
  } catch (error) {
    if (error instanceof FileEncodingError)
      return {problem: `recipe ${id} is not valid UTF-8`};
    throw error;
  }
  if (text === null) return {problem: `recipe ${id} is not on main`};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {problem: `recipe ${id} is not valid JSON`};
  }
  const errors = recipeErrors(value);
  if (errors.length)
    return {
      problem: `recipe ${id} is invalid: ${errors.slice(0, 3).join('; ')}`,
    };
  const recipe = value as Recipe;
  if (!recipe.units || !recipe.manifest_revision)
    return {
      problem: `recipe ${id} has no units or manifest revision to dispatch`,
    };
  const seen = new Set<string>();
  for (const unit of recipe.units) {
    // Units are listed in dependency order, which also rules out cycles.
    if (
      seen.has(unit.unit_id) ||
      !unit.depends_on.every(dependency => seen.has(dependency))
    )
      return {
        problem: `recipe ${id} unit ${unit.unit_id} is duplicated or depends on a later unit`,
      };
    seen.add(unit.unit_id);
  }
  // A recipe says how to do one step for its source: it fetches or it builds, never both.
  const fetches = recipe.units.filter(unit => unit.kind === 'acquire').length;
  if (fetches && fetches !== recipe.units.length)
    return {
      problem: `recipe ${id} mixes fetch and build units; a recipe does only one of them`,
    };
  return {recipe};
}
