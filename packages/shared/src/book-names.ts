/** Normalize aliases while treating Roman numerals as numbers only when separated. */
export function foldBookName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/^(iv|iii|ii|i)(?=[\s.])/, numeral => String(numeral === 'iv' ? 4 : numeral.length))
    .replace(/[\s.()]/g, '');
}
