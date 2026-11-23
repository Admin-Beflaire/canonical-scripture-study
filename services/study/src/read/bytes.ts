const encoder = new TextEncoder();
export {
  canonicalJson,
  sha256Hex,
} from '../../../../packages/shared/src/digest.ts';

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

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Non-empty identifier without lone surrogates and with a fixed upper length. */
export function isIdentifier(value: unknown, max = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
