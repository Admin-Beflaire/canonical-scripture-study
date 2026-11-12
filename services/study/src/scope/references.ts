import { ReadError } from '../read/states.ts';
import { bookCode } from './books.ts';

/** One reference as written by the host, in the source's own chapter and verse numbering.
 *  `verses` null means the whole chapter(s). Nothing here assumes another source's numbering. */
export interface PassageRequest {
  text: string; book: string; from: { chapter: number; verse: number | null }; to: { chapter: number; verse: number | null };
}

/** The longest chapter in the loaded numbering systems (Psalm 119 has 176 verses). Unit
 *  candidates above a chapter's real end simply match nothing. */
export const MAX_VERSES = 180;
/** At most this many chapters per reference, so one reference stays a bounded read. */
export const MAX_CHAPTERS = 3;

const PATTERN = /^\s*((?:[1-3]|i{1,3})?\s*[A-Za-z][A-Za-z .]*?)\s*(\d+)(?:\s*[:.]\s*(\d+))?(?:\s*[-–—]\s*(\d+)(?:\s*[:.]\s*(\d+))?)?\s*$/i;

/** Parses "Gen 1:1-2:3", "Genesis 1", "Mt 5:3-12" or "John 1:1". Unknown books, reversed or
 *  oversized ranges are rejected with a useful message; no reference is guessed. */
export function parseReference(text: string): PassageRequest {
  if (typeof text !== 'string' || text.length > 80) throw new ReadError('invalid_request', 'A reference is a short text such as "Gen 1:1-2:3"');
  const match = text.match(PATTERN);
  if (!match) throw new ReadError('invalid_request', `Could not read the reference "${text}"; write it like "Gen 1:1-2:3" or "Matthew 5"`);
  const book = bookCode(match[1]);
  if (!book) throw new ReadError('invalid_request', `Unknown book "${match[1].trim()}" in "${text}"`);
  const c1 = Number(match[2]);
  const v1 = match[3] === undefined ? null : Number(match[3]);
  let c2 = c1;
  let v2: number | null = v1;
  if (match[4] !== undefined) {
    if (match[5] !== undefined) { c2 = Number(match[4]); v2 = Number(match[5]); }
    else if (v1 === null) { c2 = Number(match[4]); v2 = null; }   // "Gen 1-2": chapters
    else v2 = Number(match[4]);                                    // "Gen 1:1-5": verses
  }
  if (v1 !== null && v2 === null) v2 = v1;
  const bad = [c1, c2, v1 ?? 1, v2 ?? 1].some(n => !Number.isSafeInteger(n) || n < 1 || n > 999);
  if (bad || c2 < c1 || (c2 === c1 && v1 !== null && v2 !== null && v2 < v1))
    throw new ReadError('invalid_request', `The range in "${text}" is not in reading order`);
  if (c2 - c1 + 1 > MAX_CHAPTERS)
    throw new ReadError('invalid_request', `"${text}" spans more than ${MAX_CHAPTERS} chapters; ask for it in parts`);
  return { text: text.trim(), book, from: { chapter: c1, verse: v1 }, to: { chapter: c2, verse: v2 } };
}

/** Candidate native unit IDs for a reference (`Gen.1.1`): every verse it names, assuming no
 *  more than MAX_VERSES per chapter. Candidates beyond a chapter's end match nothing. */
export function candidateUnits(ref: PassageRequest): string[] {
  const units: string[] = [];
  for (let chapter = ref.from.chapter; chapter <= ref.to.chapter; chapter++) {
    const first = chapter === ref.from.chapter && ref.from.verse !== null ? ref.from.verse : 1;
    const last = chapter === ref.to.chapter && ref.to.verse !== null ? ref.to.verse : MAX_VERSES;
    for (let verse = first; verse <= last; verse++) units.push(`${ref.book}.${chapter}.${verse}`);
  }
  return units;
}

/** The whole chapters a reference sits in: its default reading context. */
export function contextUnits(ref: PassageRequest): string[] {
  return candidateUnits({ ...ref, from: { chapter: ref.from.chapter, verse: null }, to: { chapter: ref.to.chapter, verse: null } });
}
