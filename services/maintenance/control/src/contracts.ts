import jobsSchema from '../../../../schemas/maintenance/jobs.v1.schema.json' with {type: 'json'};
import recipeSchema from '../../../../schemas/maintenance/recipe.v1.schema.json' with {type: 'json'};

/** Versioned job envelopes shared with the Python executor. Workers cannot compile
 *  schemas at runtime, so this validates the small keyword subset the schema uses and
 *  rejects any other keyword, keeping `schemas/maintenance/jobs.v1.schema.json` the
 *  single source of truth. */
type Schema = Record<string, unknown>;
const SUPPORTED = new Set([
  'type',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'required',
  'properties',
  'additionalProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  '$ref',
  'description',
]);
type Defs = Record<string, Schema>;
const defs = (jobsSchema as {$defs: Defs}).$defs;
const recipeDefs = (recipeSchema as {$defs: Defs}).$defs;

function typeOf(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function checkString(
  schema: Schema,
  value: string,
  path: string,
  errors: string[],
) {
  const length = [...value].length;
  if (typeof schema.minLength === 'number' && length < schema.minLength)
    errors.push(`${path}: too short`);
  if (typeof schema.maxLength === 'number' && length > schema.maxLength)
    errors.push(`${path}: too long`);
  if (
    typeof schema.pattern === 'string' &&
    !new RegExp(schema.pattern, 'u').test(value)
  )
    errors.push(`${path}: invalid format`);
}

function checkArray(
  schema: Schema,
  items: unknown[],
  path: string,
  errors: string[],
  from: Defs,
) {
  if (typeof schema.maxItems === 'number' && items.length > schema.maxItems)
    errors.push(`${path}: too many items`);
  if (typeof schema.minItems === 'number' && items.length < schema.minItems)
    errors.push(`${path}: too few items`);
  if (schema.items)
    items.forEach((item, index) =>
      check(schema.items as Schema, item, `${path}[${index}]`, errors, from),
    );
}

function checkObject(
  schema: Schema,
  object: Record<string, unknown>,
  path: string,
  errors: string[],
  from: Defs,
) {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  if (
    typeof schema.maxProperties === 'number' &&
    Object.keys(object).length > schema.maxProperties
  )
    errors.push(`${path}: too many fields`);
  for (const name of (schema.required ?? []) as string[])
    if (!Object.hasOwn(object, name)) errors.push(`${path}.${name}: required`);
  for (const [name, item] of Object.entries(object)) {
    if (Object.hasOwn(properties, name))
      check(properties[name], item, `${path}.${name}`, errors, from);
    else if (schema.additionalProperties === false)
      errors.push(`${path}.${name}: not allowed`);
  }
}

/** Does the value have one of the schema's types? An integer also counts as a number. */
function hasType(schema: Schema, actual: string): string[] | null {
  if (schema.type === undefined) return null;
  const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
  const fits =
    allowed.includes(actual) ||
    (actual === 'integer' && allowed.includes('number'));
  return fits ? null : allowed;
}

/** The definition a `$ref` points to; an unknown or malformed reference is a programming error. */
function resolveRef(ref: string, from: Defs): Schema {
  const name = /^#\/\$defs\/([a-z_]+)$/.exec(ref)?.[1];
  if (!name || !from[name]) throw new Error(`Unknown schema reference ${ref}`);
  return from[name];
}

/** Checks of the keywords that apply to any value: const, enum, strings and minimum. */
function checkScalar(
  schema: Schema,
  value: unknown,
  path: string,
  errors: string[],
) {
  if (schema.const !== undefined && value !== schema.const)
    errors.push(`${path}: must be ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${path}: not an allowed value`);
  if (typeof value === 'string') checkString(schema, value, path, errors);
  if (
    typeof value === 'number' &&
    typeof schema.minimum === 'number' &&
    value < schema.minimum
  )
    errors.push(`${path}: below minimum`);
}

function check(
  schema: Schema,
  value: unknown,
  path: string,
  errors: string[],
  from: Defs = defs,
) {
  for (const key of Object.keys(schema))
    if (!SUPPORTED.has(key))
      throw new Error(`Unsupported schema keyword ${key}`);
  if (typeof schema.$ref === 'string') {
    check(resolveRef(schema.$ref, from), value, path, errors, from);
    return;
  }
  const actual = typeOf(value);
  const wrongType = hasType(schema, actual);
  if (wrongType) {
    errors.push(`${path}: expected ${wrongType.join(' or ')}`);
    return;
  }
  checkScalar(schema, value, path, errors);
  if (actual === 'array')
    checkArray(schema, value as unknown[], path, errors, from);
  if (actual === 'object')
    checkObject(schema, value as Record<string, unknown>, path, errors, from);
}

export type ArtifactRef = {
  artifact_id: string;
  sha256: string;
  byte_count: number;
};
export type InputRef = {
  kind: 'source_revision' | 'artifact' | 'acquisition';
  id: string;
  sha256?: string;
  byte_count?: number;
};
export interface JobInput {
  contract_version: 'maintenance-job/1';
  task_id: string;
  task_revision: number;
  unit_id: string;
  attempt: number;
  kind: 'acquire' | 'prepare' | 'quality';
  basis_digest: string;
  input_refs: InputRef[];
  manifest_revision: string;
  recipe_revision: string;
  native_extent: Record<string, unknown>;
  required_capabilities: string[];
  dependency_refs: ArtifactRef[];
  constraints: Record<string, unknown>;
}
export interface JobResult {
  contract_version: 'maintenance-job/1';
  task_id: string;
  task_revision: number;
  unit_id: string;
  attempt: number;
  basis_digest: string;
  run_id: string;
  completed_extent: Record<string, unknown>;
  remaining_extent: Record<string, unknown>;
  output_refs: ArtifactRef[];
  coverage_refs: string[];
  quality_receipt_ref: ArtifactRef | null;
  state: 'succeeded' | 'failed' | 'cancelled';
  diagnostics: {code: string; message: string}[];
}
export const CONTRACT_VERSION = 'maintenance-job/1';

/** Returns the list of problems; empty means valid. */
export function contractErrors(
  name: 'job_input' | 'job_result',
  value: unknown,
): string[] {
  const errors: string[] = [];
  check(defs[name], value, '$', errors);
  return errors;
}
/** Problems with a preparation recipe (schemas/maintenance/recipe.v1.schema.json). */
export function recipeErrors(value: unknown): string[] {
  const errors: string[] = [];
  check(recipeDefs.recipe, value, '$', errors, recipeDefs);
  return errors;
}
export interface RecipeUnit {
  unit_id: string;
  kind: JobInput['kind'];
  native_extent: Record<string, unknown>;
  depends_on: string[];
  required_capabilities?: string[];
}
export interface Recipe {
  id: string;
  revision: string;
  manifest_revision?: string;
  adapter?: {name: string; method_version: string};
  parameters?: Record<string, unknown>;
  native_extent?: Record<string, unknown>;
  capabilities?: string[];
  /** The inputs a task for this recipe names, so they are never guessed. */
  task_inputs?: {kind: string; id: string}[];
  units?: RecipeUnit[];
}
export function assertJobInput(value: unknown): asserts value is JobInput {
  const errors = contractErrors('job_input', value);
  if (errors.length)
    throw new Error(`Invalid job input: ${errors.slice(0, 5).join('; ')}`);
}
export function assertJobResult(value: unknown): asserts value is JobResult {
  const errors = contractErrors('job_result', value);
  if (errors.length)
    throw new Error(`Invalid job result: ${errors.slice(0, 5).join('; ')}`);
}
