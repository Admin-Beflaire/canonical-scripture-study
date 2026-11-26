import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parseReference} from '../../services/study/src/scope/references.ts';

test('every basis reference of the statement file can be read in passage mode', () => {
  const statement = JSON.parse(
    readFileSync(
      new URL(
        '../../collection/character-of-god-statement.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {scripture_basis: string[]};
  assert.ok(statement.scripture_basis.length > 0);
  for (const reference of statement.scripture_basis)
    assert.doesNotThrow(() => parseReference(reference), reference);
});
