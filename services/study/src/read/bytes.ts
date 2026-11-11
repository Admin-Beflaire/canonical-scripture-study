const encoder = new TextEncoder();

/** Index keys are sorted by unsigned UTF-8 bytes (Data Indexes contract). JavaScript's
 *  `<` compares UTF-16 code units, which differs for characters above U+FFFF. */
export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

export function utf8Length(text: string): number { return encoder.encode(text).length; }

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable JSON: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/** Non-empty identifier without lone surrogates and with a fixed upper length. */
export function isIdentifier(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\uD800-\uDFFF]/u.test(value);
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
