import test from 'node:test';
import assert from 'node:assert/strict';
import { readerBook, readerVerses } from '../../packages/shared/src/reader-catalogue.ts';

test('the reader catalogue resolves aliases and checks exact chapter extents', () => {
  const malachi = readerBook('Malachi')!;
  assert.deepEqual(readerVerses(malachi, { chapter: 4, verse: null }, { chapter: 4, verse: null }),
    ['Mal.4.1', 'Mal.4.2', 'Mal.4.3', 'Mal.4.4', 'Mal.4.5', 'Mal.4.6']);
  assert.equal(readerBook('Psa')?.book_id, 'Ps');
  assert.equal(readerBook('II Corinthians')?.book_id, '2Cor');
  assert.equal(readerBook('IV Maccabees')?.book_id, '4Macc');
  assert.throws(() => readerVerses(malachi, { chapter: 3, verse: 23 }, { chapter: 3, verse: 24 }));
  const greekEsther = readerBook('Greek Esther')!;
  assert.equal(readerVerses(greekEsther, { chapter: 11, verse: null }, { chapter: 11, verse: null })[0], 'EsthGr.11.2');
});
