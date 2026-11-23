import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canonicalJson, sha256Hex} from '../../packages/shared/src/digest.ts';

test('canonical JSON and SHA-256 preserve stable identities', async () => {
  assert.equal(
    canonicalJson({z: [3, {b: 2, a: 1}], a: 'x', ignored: undefined}),
    '{"a":"x","z":[3,{"a":1,"b":2}]}',
  );
  const expected =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex('abc'), expected);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), expected);
});
