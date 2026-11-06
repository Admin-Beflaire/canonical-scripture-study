import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import nativeSchema from "../../schemas/native-reference.v1.schema.json" with { type: "json" };
import recordSchema from "../../schemas/evidence-records.v1.schema.json" with { type: "json" };
import { parseReference, serializeReference } from "../../packages/shared/src/index.ts";
import type { NativeReference } from "../../packages/shared/src/index.ts";

type Row = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("../conformance/evidence-records.v1.json", import.meta.url), "utf8")) as {
  fixture_version: string; records: Record<string, Row[]>;
  artifact_text: Record<string, string>; expected_range_text: string[];
};
assert.equal(fixture.fixture_version, "evidence-contracts/1");
const ajv = new Ajv({ strict: true, allErrors: true }).addSchema(nativeSchema).addSchema(recordSchema);
const validator = (name: string) => ajv.compile({ $ref: `${recordSchema.$id}#/$defs/${name}` });
for (const [name, rows] of Object.entries(fixture.records)) {
  test(`evidence record round trips: ${name}`, () => {
    const validate = validator(name);
    for (const row of rows) {
      assert.equal(validate(row), true, JSON.stringify(validate.errors));
      assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
      assert.equal(validate({ ...row, unrecognized: true }), false);
    }
  });
}

test("native span identities use the existing common reference encoding", () => {
  for (const row of fixture.records.native_span) {
    const reference = { schema_version: "native-reference/1", source_revision_id: row.source_revision_id,
      coordinate_version: row.coordinate_version, segments: row.segments_json } as NativeReference;
    assert.deepEqual(parseReference(serializeReference(reference)), reference);
  }
});

test("UTF-8 ranges preserve segment order and exact digests", () => {
  const row = fixture.records.native_span.find(row => row.id === "span-range")!;
  const ranges = row.body_ranges_json as { segment_ordinal: number; artifact_id: string; byte_offset: number; byte_length: number; sha256: string }[];
  const text = ranges.map((range, index) => {
    assert.equal(range.segment_ordinal, index);
    const bytes = Buffer.from(fixture.artifact_text[range.artifact_id], "utf8").subarray(range.byte_offset, range.byte_offset + range.byte_length);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), range.sha256);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
  assert.deepEqual(text, fixture.expected_range_text);
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from("😀").subarray(1)));
});

test("schema rejects ambiguous bodies, unsafe ranges and fake held references", () => {
  const span = structuredClone(fixture.records.native_span[0]);
  assert.equal(validator("native_span")({ ...span, body_ranges_json: [{ segment_ordinal: 0, artifact_id: "range-body", byte_offset: 0, byte_length: 2, sha256: "a".repeat(64) }] }), false);
  assert.equal(validator("body_range")({ segment_ordinal: 0, artifact_id: "range-body", byte_offset: -1, byte_length: 1, sha256: "a".repeat(64) }), false);
  assert.equal(validator("body_range")({ segment_ordinal: 0, artifact_id: "range-body", byte_offset: Number.MAX_SAFE_INTEGER + 1, byte_length: 1, sha256: "a".repeat(64) }), false);
  assert.equal(validator("held_reference")({ availability: "held", attribution: "Synthetic", locator: "https://example.invalid" }), false);
  const pkg = fixture.records.study_package[0];
  assert.equal(validator("study_package")({ ...pkg, answer: "an AI answer" }), false);
  assert.equal(validator("character_statement")({ ...fixture.records.character_statement[0], owner_approval_ref: null }), false);
  assert.equal(validator("relation_member")({ relationship_id: "r", role: "to", ordinal: 0, span_id: null, correspondence: "missing", gap_reason: null }), false);
});

test("artifact locators contain portable keys rather than provider destinations", () => {
  const validate = validator("artifact");
  const artifact = fixture.records.artifact[0];
  for (const invalid of ["https://example.invalid/bucket/key", "r2://bucket/key", "/absolute", "a/../b", "../b", "a\\b", "key?token=x", "key#fragment"]) {
    assert.equal(validate({ ...artifact, registered_locator: invalid }), false, invalid);
  }
  for (const bucket of ["synthetic-bucket-one", "replacement-bucket-two"]) {
    const resolved = { bucket, key: artifact.registered_locator };
    assert.equal(resolved.key, artifact.registered_locator);
  }
});
