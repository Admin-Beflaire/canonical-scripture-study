import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import schema from "../../schemas/native-reference.v1.schema.json" with { type: "json" };
import {
  assertReference, parseReference, serializeReference, extractScalarSegments, mappingsFor,
} from "../../packages/shared/src/index.ts";
import type { NativeReference, VersificationMapping } from "../../packages/shared/src/index.ts";

interface ReferenceCase {
  id: string; valid: boolean; input: unknown; serialized: string; schema_valid?: boolean;
}
interface ExtractionCase {
  id: string; valid: boolean; reference: NativeReference;
  basis: { source_revision_id: string; coordinate_version: string; units: Record<string, string> };
  expected: string[];
}
interface MappingCase {
  id: string; valid: boolean; reference: NativeReference; mappings: VersificationMapping[];
  expected: VersificationMapping[]; check_detached?: boolean;
}
const fixtures = JSON.parse(readFileSync(new URL("../conformance/native-reference.v1.json", import.meta.url), "utf8")) as {
  fixture_version: string; references: ReferenceCase[]; parse: { id: string; input: string }[];
  extraction: ExtractionCase[]; mappings: MappingCase[];
};
assert.equal(fixtures.fixture_version, "native-reference-conformance/1");
const validateSchema = new Ajv({ strict: true }).compile(schema);

for (const fixture of fixtures.references) {
  test(`reference conformance: ${fixture.id}`, () => {
    assert.equal(validateSchema(fixture.input), fixture.schema_valid ?? fixture.valid);
    if (fixture.valid) {
      assertReference(fixture.input);
      assert.equal(serializeReference(fixture.input), fixture.serialized);
      assert.deepEqual(parseReference(fixture.serialized), fixture.input);
    } else {
      assert.throws(() => assertReference(fixture.input));
      assert.throws(() => serializeReference(fixture.input as NativeReference));
      assert.throws(() => parseReference(JSON.stringify(fixture.input)));
    }
  });
}
for (const fixture of fixtures.parse) {
  test(`parse conformance: ${fixture.id}`, () => {
    assert.throws(() => parseReference(fixture.input));
  });
}
for (const fixture of fixtures.extraction) {
  test(`scalar conformance: ${fixture.id}`, () => {
    const basis = { ...fixture.basis, units: new Map(Object.entries(fixture.basis.units)) };
    if (fixture.valid) assert.deepEqual(extractScalarSegments(fixture.reference, basis), fixture.expected);
    else assert.throws(() => extractScalarSegments(fixture.reference, basis));
  });
}
for (const fixture of fixtures.mappings) {
  test(`mapping conformance: ${fixture.id}`, () => {
    const snapshot = structuredClone(fixture.mappings);
    if (fixture.valid) {
      const result = mappingsFor(fixture.reference, fixture.mappings);
      assert.deepEqual(result, fixture.expected);
      if (fixture.check_detached) {
        result[0].to.reverse();
        assert.deepEqual(fixture.mappings, snapshot);
      }
    } else {
      assert.throws(() => mappingsFor(fixture.reference, fixture.mappings));
    }
  });
}
