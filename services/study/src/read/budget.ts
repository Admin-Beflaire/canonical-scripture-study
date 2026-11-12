import type { StudyReadEnvironment } from './bindings.ts';
import { ReadError } from './states.ts';

/** Per-request read allowance. The whole request counts: the current-release read,
 *  context queries and search pages all draw from the same allowance. */
export interface BudgetLimits {
  d1Calls: number;     // D1 queries, including the current-release read
  r2Reads: number;     // R2 object or range reads
  pageBytes: number;   // largest single R2 read (encoded index page or body range)
  r2Bytes: number;     // all R2 bytes read in this request
  resultBytes: number; // encoded evidence returned in one batch
  rowsPerQuery: number; // LIMIT on any one D1 query
}

/** Starting budgets. D1 calls and R2 reads follow the CF-02 measurement on Workers Free (at most
 *  2 D1 calls and 3–4 R2 reads per request). Pages follow Data Indexes 0.6: one 16 KB cap for the
 *  manifest, directory pages and postings pages, so a request can read the manifest, one directory
 *  page and two postings pages (`r2Bytes`, four pages). The 16 KB cap, `resultBytes` and
 *  `rowsPerQuery` await the Workers fit measurement before production limits are fixed. */
export const STARTING_LIMITS: Readonly<BudgetLimits> = Object.freeze({
  d1Calls: 2, r2Reads: 4, pageBytes: 16384, r2Bytes: 65536, resultBytes: 16384, rowsPerQuery: 50,
});

function configured(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Platform owns the configured caps; Study never exceeds them nor its own starting budget.
 *  A malformed configured value fails closed. */
export function limitsFor(env: Partial<StudyReadEnvironment>, starting: BudgetLimits = STARTING_LIMITS): BudgetLimits {
  const raw = [env.MAX_PAGE_BYTES, env.REQUEST_BYTES, env.MAX_D1_CALLS, env.MAX_SUBREQUESTS];
  if (raw.some(value => value !== undefined && value !== '' && configured(value) === undefined))
    throw new ReadError('temporary_failure', 'Invalid configured read limits');
  const [page, request, d1, subrequests] = raw.map(configured);
  const d1Calls = Math.min(starting.d1Calls, d1 ?? Infinity, subrequests ?? Infinity);
  const r2Reads = Math.min(starting.r2Reads, Math.max(0, (subrequests ?? Infinity) - d1Calls));
  const r2Bytes = Math.min(starting.r2Bytes, request ?? Infinity);
  return { ...starting, d1Calls, r2Reads, r2Bytes, pageBytes: Math.min(starting.pageBytes, page ?? Infinity, r2Bytes) };
}

export interface BudgetUsage { d1Calls: number; d1RowsRead: number; r2Reads: number; r2Bytes: number; resultBytes: number }

/** Counts work before it happens so callers can stop and continue in another request. */
export class RequestBudget {
  private used: BudgetUsage = { d1Calls: 0, d1RowsRead: 0, r2Reads: 0, r2Bytes: 0, resultBytes: 0 };
  readonly limits: BudgetLimits;
  constructor(limits: BudgetLimits) { this.limits = limits; }

  canQuery(calls = 1) { return this.used.d1Calls + calls <= this.limits.d1Calls; }
  /** A `page` read (index page or body range) is capped by `pageBytes`; a whole small
   *  object such as an index manifest only by the request's remaining R2 bytes. */
  canRead(bytes: number, kind: 'page' | 'object' = 'page') {
    return Number.isSafeInteger(bytes) && bytes >= 0 && (kind === 'object' || bytes <= this.limits.pageBytes)
      && this.used.r2Reads + 1 <= this.limits.r2Reads && this.used.r2Bytes + bytes <= this.limits.r2Bytes;
  }
  canReturn(bytes: number) { return this.used.resultBytes + bytes <= this.limits.resultBytes; }

  spendQuery(rowsRead = 0) {
    if (!this.canQuery()) throw new ReadError('budget', 'D1 query allowance used');
    this.used.d1Calls += 1;
    this.used.d1RowsRead += rowsRead;
  }
  recordRows(rowsRead: number) { this.used.d1RowsRead += rowsRead; }
  spendRead(bytes: number, kind: 'page' | 'object' = 'page') {
    if (!this.canRead(bytes, kind)) throw new ReadError('budget', 'R2 read allowance used');
    this.used.r2Reads += 1;
    this.used.r2Bytes += bytes;
  }
  spendResult(bytes: number) {
    if (!this.canReturn(bytes)) throw new ReadError('budget', 'Result allowance used');
    this.used.resultBytes += bytes;
  }
  usage(): BudgetUsage { return { ...this.used }; }
}
