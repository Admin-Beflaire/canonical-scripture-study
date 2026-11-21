/** The small parts of the D1 and R2 bindings Study reads. Tests supply local stand-ins.
 *  Study never receives a write method from this module; see `session.ts`. */
export interface D1ReadResult<T> { results: T[]; meta?: { rows_read?: number; changes?: number } }
export interface D1ReadStatement {
  bind(...values: unknown[]): D1ReadStatement;
  all<T = Record<string, unknown>>(): Promise<D1ReadResult<T>>;
}
export interface D1ReadDatabase { prepare(sql: string): D1ReadStatement }

export interface R2RangeObject { arrayBuffer(): Promise<ArrayBuffer> }
export interface R2ReadBucket {
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<R2RangeObject | null>;
}

/** Optional, short-lived global cache. It stores only already verified unfinished entry wording. */
export interface VerifiedWordCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

/** Bindings and configured limits as Platform supplies them to the Study Worker. */
export interface StudyReadEnvironment {
  DATA_DB: D1ReadDatabase;
  PRIVATE_OBJECTS: R2ReadBucket;
  VERIFIED_WORD_CACHE?: VerifiedWordCache;
  AID_KV_CACHE_ENABLED?: boolean | 'true' | 'false';
  MAX_PAGE_BYTES?: string | number;
  REQUEST_BYTES?: string | number;
  MAX_D1_CALLS?: string | number;
  MAX_SUBREQUESTS?: string | number;
}
