import type { D1ReadDatabase, R2ReadBucket, StudyReadEnvironment, VerifiedWordCache } from './bindings.ts';
import { RequestBudget, limitsFor, type BudgetLimits } from './budget.ts';
import { QUERIES, isQueryName, type QueryInput, type QueryName } from './queries.ts';
import { ReadError } from './states.ts';
import { utf8Length } from './bytes.ts';
import readerCatalogue from '../../../../schemas/reader-references/nrsva-1.json' with { type: 'json' };

/** Release formats this Study reads. A release recording another version is not read. */
export const SUPPORTED_SCHEMA_VERSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  evidence_records: ['1'], native_reference: ['1'], index_manifest: ['2'],
  reader_scheme_version: [readerCatalogue.reader_scheme_version],
});

export interface CurrentRelease { id: string; schema_versions: Record<string, string> }
type QueryResult = { rows: Record<string, unknown>[]; more: boolean };

const MAX_CACHED_QUERIES = 32;
const CACHE_ENTRY_BYTES = 64 * 1024;
/** Each binding keeps the last observed release's immutable results in this Worker instance.
 *  Store serialized results so a caller cannot mutate a later request's evidence. */
const READ_CACHES = new WeakMap<D1ReadDatabase, { releaseId: string; results: Map<string, string> }>();

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
  readonly #cache: Map<string, string>;
  readonly objects: R2ReadBucket;
  readonly verifiedWords?: VerifiedWordCache;
  readonly budget: RequestBudget;
  readonly release: CurrentRelease;
  private constructor(db: D1ReadDatabase, objects: R2ReadBucket, budget: RequestBudget, release: CurrentRelease,
    verifiedWords?: VerifiedWordCache) {
    this.#db = db; this.objects = objects; this.budget = budget; this.release = release; this.verifiedWords = verifiedWords;
    const cached = READ_CACHES.get(db);
    this.#cache = cached?.releaseId === release.id ? cached.results : new Map();
    if (cached?.releaseId !== release.id) READ_CACHES.set(db, { releaseId: release.id, results: this.#cache });
  }

  /** Reads `release_selection.current_release_id` once. Never falls back to previous. */
  static async open(env: StudyReadEnvironment, limits: BudgetLimits = limitsFor(env)): Promise<ReadSession> {
    const budget = new RequestBudget(limits);
    const rows = await run<{ release_id: string | null; schema_versions_json: string | null }>(env.DATA_DB, budget, CURRENT, []);
    const row = rows[0];
    if (!row || row.release_id === null) throw new ReadError('no_current_release', 'No release is currently selected');
    if (row.schema_versions_json === null) throw new ReadError('incompatible_release', 'The selected release record is missing');
    return new ReadSession(env.DATA_DB, env.PRIVATE_OBJECTS, budget, { id: row.release_id, schema_versions: checkVersions(row.schema_versions_json) },
      env.VERIFIED_WORD_CACHE);
  }

  /** Runs one allowlisted query for the current release. Returns at most `rowsPerQuery`
   *  rows and whether more remain. Cache hits spend no D1 allowance. */
  async query<N extends QueryName>(name: N, input: QueryInput<N>): Promise<QueryResult> {
    const result = await this.queryIfAvailable(name, input);
    if (result === null) throw new ReadError('budget', 'D1 query allowance used');
    return result;
  }

  /** Cache first, then use a D1 call if available. A null result means the caller can continue later. */
  async queryIfAvailable<N extends QueryName>(name: N, input: QueryInput<N>): Promise<QueryResult | null> {
    if (!isQueryName(name)) throw new ReadError('invalid_request', 'Unknown query');
    const declaration = QUERIES[name] as { sql: string; params(input: unknown): unknown[] };
    // One mapping page must also fit the bounded span lookup used to fetch its targets.
    const limit = name === 'literary_contexts' ? 1 : name === 'reader_mappings' ? Math.min(this.budget.limits.rowsPerQuery, 20) : this.budget.limits.rowsPerQuery;
    const values = [this.release.id, ...declaration.params(input ?? {}), limit + 1];
    const key = JSON.stringify([name, ...values]);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      this.budget.recordCache(true);
      return JSON.parse(cached) as QueryResult;
    }

    if (!this.budget.canQuery()) return null;
    this.budget.recordCache(false);
    const rows = await run<Record<string, unknown>>(this.#db, this.budget, declaration.sql, values);
    const result = { rows: rows.slice(0, limit), more: rows.length > limit };
    const body = JSON.stringify(result);
    if (key.length + body.length <= CACHE_ENTRY_BYTES
        && utf8Length(key) + utf8Length(body) <= CACHE_ENTRY_BYTES) {
      this.#cache.delete(key);
      if (this.#cache.size >= MAX_CACHED_QUERIES) this.#cache.delete(this.#cache.keys().next().value!);
      this.#cache.set(key, body);
    }
    return result;
  }
}
