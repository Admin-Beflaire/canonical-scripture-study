import type {InputRef} from './contracts.ts';
import type {D1Database} from './d1.ts';
import {GitHubError, type RecipeFiles} from './github.ts';
import {findFetchRecipe, originalState, readOriginal} from './originals.ts';
import type {ObjectStore} from './release-check.ts';
import type {Scope} from './tasks.ts';

/** Admission is asked once (Maintenance Technical §4). `request_task` and `get_recipe` use this
 *  one check, so what is announced is what is asked. An admission is never inferred: without a
 *  saved record that still applies, the owner's decision is needed. */

/** What the check reads besides the database; without it an acquisition is always asked. */
export interface AdmissionSources {
  github: RecipeFiles | null;
  objects: ObjectStore | null;
}

/** A source revision needs no decision when every admission recorded for it is eligible. */
async function revisionDoubt(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(both_hosts_eligible = 1) AS eligible
    FROM admissions WHERE source_revision_id = ?`,
    )
    .bind(id)
    .first<{total: number; eligible: number | null}>();
  return row && row.total > 0 && row.eligible === row.total
    ? null
    : 'this source is not admitted for both hosts';
}

/** An input that states its own digest or size must state the admitted ones. */
function statesOtherBytes(
  input: InputRef,
  digest: string | null,
  size: number | null,
) {
  return (
    (input.sha256 !== undefined && input.sha256 !== digest) ||
    (input.byte_count !== undefined && input.byte_count !== size)
  );
}

async function acquisitionDoubt(
  db: D1Database,
  {github, objects}: AdmissionSources,
  input: InputRef,
  recipes: string[],
) {
  if (!github)
    return 'Control cannot read the recipe to compare a recorded admission';
  const found = await findFetchRecipe(github, input, recipes);
  if (!found) return 'no fetch recipe on main states this route';
  const original = await readOriginal(github, found.recipe);
  if (!original) return 'the fetch recipe states no admission record';
  if (statesOtherBytes(input, original.digest, original.size))
    return 'the request states other bytes than the recipe pins';
  return (await originalState(db, objects, original)).asks;
}

/** Why this input needs an owner admission decision, or null. `recipes` are the recipes the
 *  task names, which are read first. */
export async function admissionDoubt(
  db: D1Database,
  sources: AdmissionSources,
  input: InputRef,
  recipes: string[] = [],
): Promise<string | null> {
  if (input.kind === 'artifact') return null;
  if (input.kind === 'source_revision') return revisionDoubt(db, input.id);
  try {
    return await acquisitionDoubt(db, sources, input, recipes);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return 'the recorded admission could not be compared because GitHub did not answer; ask again in a moment';
  }
}

export const admissionNeeded = (id: string, why: string) =>
  `decision_refs: owner admission decision (kind "admission", subject "${id}") — ${why}`;

/** The decisions a request still lacks. */
export async function admissionGaps(
  db: D1Database,
  scope: Scope,
  sources: AdmissionSources,
): Promise<string[]> {
  // Removing data needs no admission.
  if (scope.steps.includes('remove')) return [];
  const decided = new Set(
    scope.decision_refs
      .filter(ref => ref.kind === 'admission' && ref.subject)
      .map(ref => ref.subject),
  );
  const recipes = [
    scope.constraints.fetch_recipe,
    scope.constraints.recipe,
  ].filter((id): id is string => typeof id === 'string');
  const gaps: string[] = [];
  for (const input of scope.inputs) {
    if (decided.has(input.id)) continue;
    const why = await admissionDoubt(db, sources, input, recipes);
    if (why) gaps.push(admissionNeeded(input.id, why));
  }
  return gaps;
}
