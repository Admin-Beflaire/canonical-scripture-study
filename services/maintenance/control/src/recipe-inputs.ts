import type {Recipe} from './contracts.ts';

export interface RecipeInput {
  kind: string;
  id: string;
}

/** The inputs a task for this recipe must name: the recipe's own list, or for an acquire-only
 *  recipe the acquisition route and the source revision it keeps. Other recipes list none. */
export function recipeInputs(recipe: Recipe): RecipeInput[] {
  if (recipe.task_inputs) return recipe.task_inputs;
  const revision = recipe.native_extent?.component;
  if (
    recipe.adapter?.name === 'acquire-only' &&
    recipe.adapter.method_version === 'acquire-only/1' &&
    typeof revision === 'string' &&
    recipe.manifest_revision
  )
    return [
      {kind: 'acquisition', id: recipe.manifest_revision},
      {kind: 'source_revision', id: revision},
    ];
  return [];
}
