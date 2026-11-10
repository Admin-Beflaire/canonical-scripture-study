import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from '../../schemas/maintenance/jobs.v1.schema.json' with { type: 'json' };
import { contractErrors, assertJobInput, assertJobResult } from '../../services/maintenance/control/src/contracts.ts';
import { canonicalJson, sha256 } from '../../services/maintenance/control/src/d1.ts';

const fixture = JSON.parse(readFileSync(new URL('../conformance/maintenance-jobs.v1.json', import.meta.url), 'utf8')) as {
  valid: Record<'job_input' | 'job_result', unknown[]>; invalid: Record<'job_input' | 'job_result', unknown[]>;
};
const ajv = new Ajv2020({ strict: true, allErrors: true }).addSchema(schema);

for (const name of ['job_input', 'job_result'] as const) {
  test(`Worker validator agrees with a full JSON Schema validator: ${name}`, () => {
    const reference = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    for (const value of fixture.valid[name]) {
      assert.equal(reference(value), true, JSON.stringify(reference.errors));
      assert.deepEqual(contractErrors(name, value), []);
    }
    for (const value of fixture.invalid[name]) {
      assert.equal(reference(value), false, JSON.stringify(value));
      assert.notDeepEqual(contractErrors(name, value), [], JSON.stringify(value));
    }
  });
}

test('assertions name the problem without echoing the envelope', () => {
  assert.doesNotThrow(() => assertJobInput(fixture.valid.job_input[0]));
  assert.doesNotThrow(() => assertJobResult(fixture.valid.job_result[0]));
  assert.throws(() => assertJobInput(fixture.invalid.job_input[6]), /\$\.script: not allowed/);
});

/** Python must receive these exact UTF-8 bytes, not a reserialized JSON object. */
test('Control canonical transport bytes are shared with the Python executor', async () => {
  const wire = JSON.parse(readFileSync(new URL('../conformance/dp04-control-wire.v1.json', import.meta.url), 'utf8')) as {
    job_input: unknown; canonical_json: string; sha256: string;
  };
  assertJobInput(wire.job_input);
  const text = canonicalJson(wire.job_input);
  assert.equal(text, wire.canonical_json);
  assert.equal(await sha256(text), wire.sha256);
  assert.notEqual(JSON.stringify(wire.job_input), text, 'generic JSON serialization is not the dispatch wire contract');
});
