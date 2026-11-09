import jobsSchema from '../../../../schemas/maintenance/jobs.v1.schema.json' with { type: 'json' };

/** Versioned job envelopes shared with the Python executor. Workers cannot compile
 *  schemas at runtime, so this validates the small keyword subset the schema uses and
 *  rejects any other keyword, keeping `schemas/maintenance/jobs.v1.schema.json` the
 *  single source of truth. */
type Schema = Record<string, unknown>;
const SUPPORTED = new Set(['type', 'enum', 'const', 'pattern', 'minLength', 'maxLength', 'minimum', 'required',
  'properties', 'additionalProperties', 'maxProperties', 'items', 'maxItems', '$ref']);
const defs = (jobsSchema as { $defs: Record<string, Schema> }).$defs;

function typeOf(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string, errors: string[]) {
  for (const key of Object.keys(schema)) if (!SUPPORTED.has(key)) throw new Error(`Unsupported schema keyword ${key}`);
  if (typeof schema.$ref === 'string') {
    const name = /^#\/\$defs\/([a-z_]+)$/.exec(schema.$ref)?.[1];
    if (!name || !defs[name]) throw new Error(`Unknown schema reference ${schema.$ref}`);
    check(defs[name], value, path, errors);
    return;
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${path}: expected ${allowed.join(' or ')}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: not an allowed value`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) errors.push(`${path}: too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: invalid format`);
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (actual === 'array') {
    const items = value as unknown[];
    if (typeof schema.maxItems === 'number' && items.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items) items.forEach((item, index) => check(schema.items as Schema, item, `${path}[${index}]`, errors));
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (typeof schema.maxProperties === 'number' && Object.keys(object).length > schema.maxProperties) errors.push(`${path}: too many fields`);
    for (const name of (schema.required ?? []) as string[]) if (!Object.hasOwn(object, name)) errors.push(`${path}.${name}: required`);
    for (const [name, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, name)) check(properties[name], item, `${path}.${name}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${name}: not allowed`);
    }
  }
}

export type ArtifactRef = { artifact_id: string; sha256: string; byte_count: number };
export type InputRef = { kind: 'source_revision' | 'artifact' | 'acquisition'; id: string; sha256?: string; byte_count?: number };
export interface JobInput {
  contract_version: 'maintenance-job/1'; task_id: string; task_revision: number; unit_id: string; attempt: number;
  kind: 'acquire' | 'prepare' | 'quality'; basis_digest: string; input_refs: InputRef[];
  manifest_revision: string; recipe_revision: string; native_extent: Record<string, unknown>;
  required_capabilities: string[]; dependency_refs: ArtifactRef[]; checkpoint_ref: ArtifactRef | null;
  constraints: Record<string, unknown>;
}
export interface JobResult {
  contract_version: 'maintenance-job/1'; task_id: string; task_revision: number; unit_id: string; attempt: number;
  basis_digest: string; run_id: string; completed_extent: Record<string, unknown>; remaining_extent: Record<string, unknown>;
  output_refs: ArtifactRef[]; coverage_refs: string[]; checkpoint_ref: ArtifactRef | null;
  quality_receipt_ref: ArtifactRef | null; state: 'checkpointed' | 'succeeded' | 'failed' | 'cancelled';
  diagnostics: { code: string; message: string }[];
}
export const CONTRACT_VERSION = 'maintenance-job/1';

/** Returns the list of problems; empty means valid. */
export function contractErrors(name: 'job_input' | 'job_result', value: unknown): string[] {
  const errors: string[] = [];
  check(defs[name], value, '$', errors);
  return errors;
}
export function assertJobInput(value: unknown): asserts value is JobInput {
  const errors = contractErrors('job_input', value);
  if (errors.length) throw new Error(`Invalid job input: ${errors.slice(0, 5).join('; ')}`);
}
export function assertJobResult(value: unknown): asserts value is JobResult {
  const errors = contractErrors('job_result', value);
  if (errors.length) throw new Error(`Invalid job result: ${errors.slice(0, 5).join('; ')}`);
}
