import type { D1ReadDatabase, R2ReadBucket, StudyReadEnvironment } from './bindings.ts';
import { RequestBudget, limitsFor, type BudgetLimits } from './budget.ts';
import { QUERIES, isQueryName, type QueryInput, type QueryName } from './queries.ts';
import { ReadError } from './states.ts';

/** Release formats this Study reads. A release recording another version is not read. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  evidence_records: ['1'], native_reference: ['1'], index_manifest: ['2'],
});

export interface CurrentRelease { id: string; schema_versions: Record<string, string> }

const CURRENT = `SELECT s.current_release_id AS release_id, r.schema_versions_json
FROM release_selection s LEFT JOIN releases r ON r.id = s.current_release_id
WHERE s.singleton_id = 1`;

const READ_ONLY = /^\s*(SELECT|WITH)\b/i;

function checkVersions(raw: unknown): Record<string, string> {
  let versions: unknown;
  try { versions = typeof raw === 'string' ? JSON.parse(raw) : undefined; } catch { versions = undefined; }
  if (!versions || typeof versions !== 'object' || Array.isArray(versions))
    throw new ReadError('incompatible_release', 'The current release has no readable format record');
  const record = versions as Record<string, unknown>;
  if (record.evidence_records === undefined) throw new ReadError('incompatible_release', 'The current release has no evidence format');
  for (const [name, supported] of Object.entries(SUPPORTED_SCHEMA_VERSIONS)) {
    if (record[name] !== undefined && !supported.includes(String(record[name])))
      throw new ReadError('incompatible_release', `Unsupported ${name} format ${String(record[name])}`);
  }
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, String(v)]));
}

async function run<T>(db: D1ReadDatabase, budget: RequestBudget, sql: string, values: unknown[]): Promise<T[]> {
  if (!READ_ONLY.test(sql) || sql.includes(';')) throw new ReadError('invalid_request', 'Only fixed read statements are allowed');
  budget.spendQuery();
  let result;
  try { result = await db.prepare(sql).bind(...values).all<T>(); }
  catch { throw new ReadError('temporary_failure', 'Data read failed'); }
  budget.recordRows(result.meta?.rows_read ?? 0);
  return result.results;
}

/** One request's read context: the current release, read once, and its allowance.
 *  Holds the bindings privately; callers reach D1 only through `query`. */
export class ReadSession {
  readonly #db: D1ReadDatabase;
  readonly objects: R2ReadBucket;
  readonly budget: RequestBudget;
  readonly release: CurrentRelease;
  private constructor(db: D1ReadDatabase, objects: R2ReadBucket, budget: RequestBudget, release: CurrentRelease) {
    this.#db = db; this.objects = objects; this.budget = budget; this.release = release;
  }

  /** Reads `release_selection.current_release_id` once. Never falls back to previous. */
  static async open(env: StudyReadEnvironment, limits: BudgetLimits = limitsFor(env)): Promise<ReadSession> {
    const budget = new RequestBudget(limits);
    const rows = await run<{ release_id: string | null; schema_versions_json: string | null }>(env.DATA_DB, budget, CURRENT, []);
    const row = rows[0];
    if (!row || row.release_id === null) throw new ReadError('no_current_release', 'No release is currently selected');
    if (row.schema_versions_json === null) throw new ReadError('incompatible_release', 'The selected release record is missing');
    return new ReadSession(env.DATA_DB, env.PRIVATE_OBJECTS, budget, { id: row.release_id, schema_versions: checkVersions(row.schema_versions_json) });
  }

  canQuery() { return this.budget.canQuery(); }

  /** Runs one allowlisted query for the current release. Returns at most `rowsPerQuery`
   *  rows and whether more remain. */
  async query<N extends QueryName>(name: N, input: QueryInput<N>): Promise<{ rows: Record<string, unknown>[]; more: boolean }> {
    if (!isQueryName(name)) throw new ReadError('invalid_request', 'Unknown query');
    const declaration = QUERIES[name] as { sql: string; params(input: unknown): unknown[] };
    const limit = this.budget.limits.rowsPerQuery;
    const values = [this.release.id, ...declaration.params(input ?? {}), limit + 1];
    const rows = await run<Record<string, unknown>>(this.#db, this.budget, declaration.sql, values);
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }
}
