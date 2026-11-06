import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import schema from "../../schemas/native-reference.v1.schema.json" with { type: "json" };
import { assertReference, parseReference, serializeReference, extractScalarSegments, mappingsFor } from "../../packages/shared/src/index.ts";
import type { NativeReference, VersificationMapping } from "../../packages/shared/src/index.ts";

const reference: NativeReference = {
  schema_version: "native-reference/1",
  source_revision_id: "synthetic:edition-a:representation:revision-1",
  coordinate_version: "synthetic:unicode-scalars/1",
  segments: [{ unit_id: "folio α", start: 2, end: 4 }, { unit_id: "folio β", start: 0, end: 1 }],
};
const target = (revision: string): NativeReference => ({ ...structuredClone(reference), source_revision_id: revision });
const validateSchema = new Ajv({ strict: true }).compile(schema);

test("schema round trip preserves exact identities and discontinuous native order", () => {
  const encoded = serializeReference(reference);
  assert.equal(validateSchema(JSON.parse(encoded)), true);
  assert.deepEqual(parseReference(encoded), reference);
  assert.equal(serializeReference(parseReference(encoded)), encoded);
  assert.notEqual(serializeReference(target("revision-2")), encoded);
  assert.notEqual(serializeReference({ ...reference, coordinate_version: "profile-2" }), encoded);
  assert.notEqual(serializeReference({ ...reference, segments: [...reference.segments].reverse() }), encoded);
  assert.notEqual(serializeReference(target("é")), serializeReference(target("é")));
});

test("invalid references reject rather than coerce or discard fields", () => {
  const invalid = [
    { ...reference, source_revision_id: "" }, { ...reference, schema_version: "future" },
    { ...reference, unexpected: true }, { ...reference, segments: [] },
    { ...reference, segments: [{ unit_id: "a", start: 3, end: 1 }] },
    { ...reference, segments: [{ unit_id: "a", start: -1, end: 1 }] },
    { ...reference, segments: [{ unit_id: "a", start: 0.5, end: 1 }] },
    { ...reference, segments: [{ unit_id: "a", start: 0, end: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...reference, segments: [{ unit_id: "a", start: "0", end: 1 }] },
  ];
  for (const value of invalid) {
    assert.throws(() => assertReference(value));
    // Reversed endpoints need semantic validation beyond JSON Schema.
    const reversed = value.segments?.[0]?.start === 3;
    if (!reversed) assert.equal(validateSchema(value), false);
  }
  assert.throws(() => parseReference("{"));
});

test("scalar extraction preserves combining marks, non-BMP text and segment order", () => {
  const basis = { ...reference, units: new Map([["folio α", "אְ😀ב"], ["folio β", "Ω"]]) };
  assert.deepEqual(extractScalarSegments(reference, basis), ["😀ב", "Ω"]);
  assert.deepEqual(extractScalarSegments({ ...reference, segments: [{ unit_id: "folio α", start: 0, end: 2 }] }, basis), ["אְ"]);
  assert.deepEqual(extractScalarSegments({ ...reference, segments: [{ unit_id: "folio α", start: 4, end: 4 }] }, basis), [""]);
  assert.throws(() => extractScalarSegments(reference, { ...basis, source_revision_id: "wrong" }));
  assert.throws(() => extractScalarSegments(reference, { ...basis, coordinate_version: "wrong" }));
  assert.throws(() => extractScalarSegments(reference, { ...basis, units: new Map() }));
  assert.throws(() => extractScalarSegments(reference, { ...basis, units: new Map([["folio α", "a"]]) }));
  assert.throws(() => extractScalarSegments(reference, { ...basis, units: new Map([["folio α", String.fromCharCode(0xd800)]]) }));
});

test("versification preserves split/reordered, partial, disputed and missing mappings", () => {
  const mappings: VersificationMapping[] = [
    { from: reference, to: [target("b:2"), target("b:1")], status: "partial", basis: "synthetic split in recorded order" },
    { from: reference, to: [target("c")], status: "disputed", basis: "synthetic competing correspondence" },
    { from: reference, to: [], status: "missing", basis: "synthetic missing unit", gap_reason: "no preserved counterpart" },
    { from: reference, to: [], status: "unresolved", basis: "synthetic unresolved alignment", gap_reason: "not established" },
    { from: target("other"), to: [reference], status: "exact", basis: "separate mapping" },
  ];
  const result = mappingsFor(parseReference(serializeReference(reference)), mappings);
  assert.deepEqual(result, mappings.slice(0, 4));
  assert.deepEqual(mappingsFor(target("absent"), mappings), []);
  assert.deepEqual(mappingsFor(target("b:2"), mappings), []); // No implicit inversion.
  result[0].to.reverse();
  assert.equal(mappings[0].to[0].source_revision_id, "b:2");
  assert.throws(() => mappingsFor(reference, [{ ...mappings[2], to: [target("b")] }]));
  assert.throws(() => mappingsFor(reference, [{ ...mappings[2], gap_reason: undefined }]));
  assert.throws(() => mappingsFor(reference, [{ ...mappings[0], basis: "" }]));
  assert.throws(() => mappingsFor(reference, [{ ...mappings[0], to: [] }]));
});
