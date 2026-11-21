import catalogue from '../../../schemas/reader-references/nrsva-1.json' with { type: 'json' };
import readerAliases from '../../../schemas/reader-references/aliases.json' with { type: 'json' };
import { foldBookName } from './book-names.ts';

type Book = (typeof catalogue.books)[number];

/** Resolve a reader-facing book name against the pinned catalogue, not a native edition. */
export function readerBook(name: string): Book | undefined {
  const key = foldBookName(name);
  return catalogue.books.find(book => [book.book_id, book.name, ...book.aliases].some(alias => foldBookName(alias) === key));
}

/** Return exact catalogue references, refusing invalid explicit endpoints. */
export function readerVerses(book: Book, from: { chapter: number; verse: number | null }, to: { chapter: number; verse: number | null }): string[] {
  if (from.chapter < 1 || to.chapter > book.chapter_count || from.chapter > to.chapter) throw new Error('Chapter is outside the reader catalogue');
  const result: string[] = [];
  for (let chapter = from.chapter; chapter <= to.chapter; chapter++) {
    const overrides = 'first_verse_overrides' in book ? book.first_verse_overrides as Record<string, number> : {};
    const first = overrides[String(chapter)] ?? 1;
    const last = book.last_verses[chapter - 1];
    const start = chapter === from.chapter ? from.verse ?? first : first;
    const end = chapter === to.chapter ? to.verse ?? last : last;
    if (start < first || start > last || end < first || end > last || start > end) throw new Error('Verse is outside the reader catalogue');
    for (let verse = start; verse <= end; verse++) result.push(`${book.book_id}.${chapter}.${verse}`);
  }
  return result;
}

/** Resolve declared alternate-number endpoints before enumerating NRSVA verses. */
export function readerAlias(book: Book, point: { chapter: number; verse: number | null }) {
  if (point.verse === null) return null;
  const key = `${book.book_id}.${point.chapter}.${point.verse}`;
  return readerAliases.aliases.find(alias => alias.from === key) ?? null;
}

/** Explain a numbering ambiguity when its NRSVA target is requested directly too. */
export function readerNumberingNotes(references: Iterable<string>): string[] {
  const asked = new Set(references);
  return readerAliases.aliases.filter(alias => asked.has(alias.to)).map(alias => alias.note);
}
