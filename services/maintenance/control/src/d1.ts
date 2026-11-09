/** The small part of the D1 binding Control uses; tests supply a local stand-in. */
export interface D1Result<T> { results: T[]; meta: { changes?: number } }
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

/** Stable JSON: sorted object keys, no whitespace. Used for digests and comparisons. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
