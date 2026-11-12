import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import fixture from '../conformance/indexes/fixture.json' with { type: 'json' };
import { runStudyFit } from '../../tools/cloudflare/study-fit.ts';

function bindings({ selected = true, corruptPostings = false } = {}) {
  const artifacts = fixture.evidence_delta.artifact.filter(row =>
    row.id === 'ix-source-manifest' || row.id === 'ix-source-postings' || row.id === 'ix-source-directory');
  const reads: string[] = [];
  const DATA_DB = {
    prepare: () => ({
      bind: (...values: string[]) => ({
        async all<T>() {
          assert.equal(values[0], 'ix-release');
          const results = !selected ? [] : values[1] === 'ix-passage'
            ? [{ exact_text: fixture.native_units['index-unit'] }] : artifacts;
          return { results: results as T[], meta: {} };
        },
      }),
    }),
  };
  const PRIVATE_OBJECTS = {
    async get(key: string, options?: { range: { offset: number; length: number } }) {
      reads.push(key);
      const artifact = artifacts.find(row => row.registered_locator === key);
      assert.ok(artifact);
      const filename = fixture.artifact_files[artifact.id as keyof typeof fixture.artifact_files];
      const data = await readFile(new URL('../conformance/indexes/' + filename, import.meta.url));
      const { offset, length } = options?.range ?? { offset: 0, length: data.length };
      const bytes = Uint8Array.from(data.subarray(offset, offset + length));
      if (corruptPostings && options && artifact.id === 'ix-source-postings') bytes[0] ^= 1;   // postings only, not the directory
      return { arrayBuffer: async () => bytes.buffer };
    },
  };
  return { DATA_DB, PRIVATE_OBJECTS, reads };
}

test('Study fit reads the selected fixture and rejects a corrupt postings range', async () => {
  const result = await runStudyFit(bindings());
  assert.deepEqual(result.matches.map(row => row.occurrence_id), fixture.expected_source_occurrences);
  await assert.rejects(runStudyFit(bindings({ corruptPostings: true })), /Fixture object digest mismatch/);
});

test('Study fit refuses an unselected fixture before reading R2', async () => {
  const instance = bindings({ selected: false });
  await assert.rejects(runStudyFit(instance), /Selected fixture unavailable/);
  assert.deepEqual(instance.reads, []);
});
