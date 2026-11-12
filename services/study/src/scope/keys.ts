/** Search keys as the indexes store them. These mirror the named normalization rules recorded
 *  in each index manifest; a key from the host is normalized with the rule of its script.
 *  Stored wording is never changed. */

// Cantillation, meteg and puncta: not part of a Hebrew search key ('stepbible-hebrew-pointed-no-accents/1').
const HEBREW_UNSEARCHED = /[֑-ֽׅ֯ׄ]/gu;
const HEBREW = /[א-ת]/u;
const GREEK = /[Ͱ-Ͽἀ-῿]/u;
const ELISION = /[᾽᾿']/gu;

export type Script = 'hebrew' | 'greek' | 'other';

export function scriptOf(text: string): Script {
  if (HEBREW.test(text)) return 'hebrew';
  if (GREEK.test(text)) return 'greek';
  return 'other';
}

/** 'stepbible-greek-folded/1': no accents or breathings, case-folded (final sigma folds to
 *  sigma, as Python's casefold did when the keys were built), one elision mark. */
function greekKey(text: string): string {
  const bare = text.normalize('NFD').replace(/\p{Mn}/gu, '');
  return bare.toLowerCase().replace(/ς/gu, 'σ').replace(ELISION, '’').normalize('NFC');
}

function hebrewKey(text: string): string {
  return text.replace(HEBREW_UNSEARCHED, '').normalize('NFC');
}

/** The stored key for a word or form typed by the host. Lemma and grammar codes are kept as given. */
export function normalizeKey(lookup: string, key: string): string {
  const trimmed = key.trim();
  if (lookup !== 'word' && lookup !== 'form') return trimmed;
  const script = scriptOf(trimmed);
  return script === 'hebrew' ? hebrewKey(trimmed) : script === 'greek' ? greekKey(trimmed) : trimmed;
}
