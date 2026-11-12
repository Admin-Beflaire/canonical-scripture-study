/** Book codes as the loaded sources use them in their native unit IDs (`Gen.1.1`), with the
 *  names a host is likely to write. Names only choose the code; they never establish that a
 *  source contains the book or how it numbers it. */
const BOOKS: ReadonlyArray<readonly [string, string, ...string[]]> = [
  ['Gen', 'Genesis', 'Ge', 'Gn'], ['Exo', 'Exodus', 'Ex', 'Exod'], ['Lev', 'Leviticus', 'Le', 'Lv'], ['Num', 'Numbers', 'Nu', 'Nm'],
  ['Deu', 'Deuteronomy', 'Dt', 'Deut'], ['Jos', 'Joshua', 'Josh'], ['Jdg', 'Judges', 'Judg'], ['Rut', 'Ruth', 'Ru'],
  ['1Sa', '1 Samuel', '1Sam'], ['2Sa', '2 Samuel', '2Sam'], ['1Ki', '1 Kings', '1Kgs'], ['2Ki', '2 Kings', '2Kgs'],
  ['1Ch', '1 Chronicles', '1Chr'], ['2Ch', '2 Chronicles', '2Chr'], ['Ezr', 'Ezra'], ['Neh', 'Nehemiah'], ['Est', 'Esther', 'Esth'],
  ['Job', 'Job'], ['Psa', 'Psalms', 'Psalm', 'Ps', 'Pss'], ['Pro', 'Proverbs', 'Prov', 'Pr'], ['Ecc', 'Ecclesiastes', 'Eccl', 'Qoh'],
  ['Sng', 'Song of Songs', 'Song of Solomon', 'Song', 'Canticles'], ['Isa', 'Isaiah', 'Is'], ['Jer', 'Jeremiah'],
  ['Lam', 'Lamentations'], ['Ezk', 'Ezekiel', 'Ezek', 'Eze'], ['Dan', 'Daniel', 'Dn'], ['Hos', 'Hosea'], ['Jol', 'Joel', 'Jl'],
  ['Amo', 'Amos', 'Am'], ['Oba', 'Obadiah', 'Obad', 'Ob'], ['Jon', 'Jonah', 'Jnh'], ['Mic', 'Micah', 'Mi'], ['Nam', 'Nahum', 'Nah'],
  ['Hab', 'Habakkuk'], ['Zep', 'Zephaniah', 'Zeph'], ['Hag', 'Haggai'], ['Zec', 'Zechariah', 'Zech'], ['Mal', 'Malachi'],
  ['Mat', 'Matthew', 'Matt', 'Mt'], ['Mrk', 'Mark', 'Mk', 'Mar'], ['Luk', 'Luke', 'Lk'], ['Jhn', 'John', 'Jn', 'Joh'],
  ['Act', 'Acts'], ['Rom', 'Romans', 'Ro'], ['1Co', '1 Corinthians', '1Cor'], ['2Co', '2 Corinthians', '2Cor'],
  ['Gal', 'Galatians'], ['Eph', 'Ephesians'], ['Php', 'Philippians', 'Phil'], ['Col', 'Colossians'],
  ['1Th', '1 Thessalonians', '1Thess'], ['2Th', '2 Thessalonians', '2Thess'], ['1Ti', '1 Timothy', '1Tim'], ['2Ti', '2 Timothy', '2Tim'],
  ['Tit', 'Titus'], ['Phm', 'Philemon', 'Phlm'], ['Heb', 'Hebrews'], ['Jas', 'James', 'Jam'], ['1Pe', '1 Peter', '1Pet'],
  ['2Pe', '2 Peter', '2Pet'], ['1Jn', '1 John', '1Joh'], ['2Jn', '2 John', '2Joh'], ['3Jn', '3 John', '3Joh'], ['Jud', 'Jude'],
  ['Rev', 'Revelation', 'Apocalypse', 'Rv'],
];

const fold = (name: string) => name.toLowerCase().replace(/[\s.]/g, '').replace(/^(i{1,3})(?=[a-z])/, m => String(m.length));
const LOOKUP = new Map<string, string>();
for (const [code, ...names] of BOOKS) for (const name of [code, ...names]) LOOKUP.set(fold(name), code);

/** The book code for a written name, or null if no book matches. */
export function bookCode(name: string): string | null {
  return LOOKUP.get(fold(name)) ?? null;
}
