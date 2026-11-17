import catalogue from '../../../schemas/reader-references/nrsva-1.json' with { type: 'json' };

type Book = (typeof catalogue.books)[number];
const fold = (s: string) => s.toLowerCase().replace(/[\s.()]/g, '').replace(/^(iv|i{1,3})(?=[a-z])/, m => String(m === 'iv' ? 4 : m.length));

/** Resolve a reader-facing book name against the pinned catalogue, not a native edition. */
export function readerBook(name: string): Book | undefined {
  const key = fold(name);
  return catalogue.books.find(book => [book.book_id, book.name, ...book.aliases].some(alias => fold(alias) === key));
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
