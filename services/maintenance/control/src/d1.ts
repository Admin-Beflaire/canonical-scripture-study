/** The small part of the D1 binding Control uses; tests supply a local stand-in. */
export interface D1Result<T> {
  results: T[];
  meta: {changes?: number};
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<never>>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result<unknown>[]>;
}

export {
  canonicalJson,
  sha256Hex as sha256,
} from '../../../../packages/shared/src/digest.ts';
