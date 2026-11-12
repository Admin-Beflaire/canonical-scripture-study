import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import native from "../../schemas/native-reference.v1.schema.json" with { type: "json" };
import evidence from "../../schemas/evidence-records.v1.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/indexes/manifest.v2.schema.json" with { type: "json" };
import postingSchema from "../../schemas/indexes/posting.v1.schema.json" with { type: "json" };
import navigationSchema from "../../schemas/indexes/span-segment.v1.schema.json" with { type: "json" };
import directorySchema from "../../schemas/indexes/directory-entry.v2.schema.json" with { type: "json" };
import { extractScalarSegments } from "../../packages/shared/src/index.ts";
import type { NativeReference } from "../../packages/shared/src/index.ts";

type Row = Record<string, unknown>;
interface Posting {
  posting_kind: string; search_key: string; source_revision_id: string; span_id: string;
  coordinate_version: string; native_order: number; occurrence_id: string;
  native_reference: NativeReference;
  analyses?: { analysis_id: string; analysis_revision_id: string; lemma_id: string; provider: string; basis: string }[];
}
const root = new URL("../conformance/indexes/", import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const fixture = json("fixture.json") as {
  fixture_version: string; manifests: Record<string, string>; postings: Record<string,string>;
  artifact_files: Record<string,string>; native_units: Record<string,string>;
  evidence_delta: Record<string,Row[]>; span_segments: Row[];
};
const ajv = new Ajv({ strict: true, allErrors: true }).addSchema(native).addSchema(evidence);
const validateManifest = ajv.compile(manifestSchema);
const validatePosting = ajv.compile(postingSchema);
const validateNavigation = ajv.compile(navigationSchema);
const validateDirectory = ajv.compile(directorySchema);
const manifests = Object.fromEntries(Object.entries(fixture.manifests).map(([name, file]) => [name, json(file)]));

for (const [name, manifest] of Object.entries(manifests)) {
  test(`index manifest and postings schema: ${name}`, () => {
    assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
    for (const file of manifest.files) {
      const data = readFileSync(new URL(fixture.postings[file.artifact_id], root));
      assert.equal(createHash("sha256").update(data).digest("hex"), file.sha256);
      const lines = data.toString("utf8").trimEnd().split("\n");
      for (const line of lines) {
        const row = JSON.parse(line);
        assert.equal(validatePosting(row), true, JSON.stringify(validatePosting.errors));
        assert.equal(row.source_revision_id, row.native_reference.source_revision_id);
        assert.equal(row.coordinate_version, row.native_reference.coordinate_version);
        const text = extractScalarSegments(row.native_reference, { source_revision_id: row.source_revision_id,
          coordinate_version: row.coordinate_version, units: new Map(Object.entries(fixture.native_units)) });
        assert.ok(text.join("").length > 0);
      }
    }
  });
}

test("index fixtures extend the evidence contracts and registered artifact identities", () => {
  assert.equal(fixture.fixture_version, "index-contracts/2");
  for (const [kind, rows] of Object.entries(fixture.evidence_delta)) {
    const validate = ajv.compile({ $ref: `${evidence.$id}#/$defs/${kind}` });
    for (const row of rows) assert.equal(validate(row), true, `${kind}: ${JSON.stringify(validate.errors)}`);
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    const coverage = fixture.evidence_delta.coverage.find(row => row.output_id === manifest.prepared_output_id)!;
    const artifact = fixture.evidence_delta.artifact.find(row => row.id === coverage.index_artifact_id)!;
    assert.equal(fixture.artifact_files[String(artifact.id)], fixture.manifests[name]);
    assert.equal(artifact.output_id, manifest.prepared_output_id);
    assert.deepEqual(coverage.native_extent_json, manifest.native_extent);
    for (const file of [...manifest.files, manifest.directory]) {
      const registered = fixture.evidence_delta.artifact.find(row => row.id === file.artifact_id)!;
      assert.equal(registered.output_id, manifest.prepared_output_id);
      assert.equal(registered.byte_count, file.byte_length);
      assert.equal(registered.sha256, file.sha256);
    }
  }
  for (const row of fixture.span_segments) assert.equal(validateNavigation(row), true);
  for (const row of fixture.evidence_delta.artifact) {
    const bytes = readFileSync(new URL(fixture.artifact_files[String(row.id)], root));
    assert.equal(bytes.length, row.byte_count);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256);
  }
});

test("index-manifest/2: the manifest fits the cap and its directory names only registered postings pages", () => {
  for (const manifest of Object.values(manifests)) {
    assert.equal(manifest.format_version, "index-manifest/2");
    const cap = manifest.encoded_page_cap_bytes;
    assert.ok(readFileSync(new URL(fixture.manifests[Object.keys(manifests).find(k => manifests[k] === manifest)!], root)).length <= cap);
    const body = readFileSync(new URL(fixture.artifact_files[manifest.directory.artifact_id], root));
    const files = new Set(manifest.files.map((f: { artifact_id: string }) => f.artifact_id));
    let offset = 0;
    for (const page of manifest.directory.pages) {
      assert.equal(page.byte_offset, offset);
      assert.ok(page.byte_length <= cap);
      const part = body.subarray(offset, offset + page.byte_length);
      assert.equal(createHash("sha256").update(part).digest("hex"), page.sha256);
      const entries = part.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      for (const entry of entries) { assert.equal(validateDirectory(entry), true); assert.ok(files.has(entry.postings_artifact_id)); }
      assert.deepEqual([entries[0].first_key, entries.at(-1).last_key], [page.first_key, page.last_key]);
      offset += page.byte_length;
    }
    assert.equal(offset, body.length);
  }
  assert.equal(validateManifest({ ...manifests.source, format_version: "index-manifest/1" }), false);
  assert.equal(validateManifest({ ...manifests.source, native_extent: { unit_ids: ["index-unit"] } }), false);
  assert.equal(validateDirectory({ first_key: "a", last_key: "a", byte_offset: 0, byte_length: 1, sha256: "0".repeat(64) }), false);
});

test("empty normalized keys remain addressable and key collation is UTF-8 bytewise", () => {
  const rows = readFileSync(new URL("source.ndjson", root), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Posting);
  assert.equal(rows[0].search_key, "");
  assert.deepEqual(extractScalarSegments(rows[0].native_reference, { source_revision_id: rows[0].source_revision_id,
    coordinate_version: rows[0].coordinate_version, units: new Map(Object.entries(fixture.native_units)) }), ["׃"]);
  assert.deepEqual(["😀", "\uE000"].sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))), ["\uE000", "😀"]);
});

test("word analyses retain provider-specific homonyms and independent relationship receipts", () => {
  const rows = readFileSync(new URL("word.ndjson", root), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Posting);
  const analyses = rows[0].analyses!;
  assert.equal(new Set(analyses.map(a => a.analysis_id)).size, 2);
  assert.equal(new Set(analyses.map(a => a.lemma_id)).size, 2);
  assert.equal(new Set(analyses.map(a => a.provider)).size, 2);
  const receipts = fixture.evidence_delta.relationship.map(r => (r.basis_json as {receipt_id: string}).receipt_id);
  assert.equal(new Set(receipts).size, 2);
});

test("initial capabilities exclude phrase/proximity/fuzzy and reject malformed metadata", () => {
  for (const capability of ["phrase", "proximity", "fuzzy"]) {
    const m = structuredClone(manifests.source); m.coverage.capabilities = [capability];
    assert.equal(validateManifest(m), false);
  }
  const sourceLemma = structuredClone(manifests.source); sourceLemma.coverage.capabilities = ["lemma_exact"];
  assert.equal(validateManifest(sourceLemma), false);
  const wordText = structuredClone(manifests.word); wordText.coverage.capabilities = ["word_exact"];
  assert.equal(validateManifest(wordText), false);
  const m = structuredClone(manifests.word); m.analysis_revision_ids = [];
  assert.equal(validateManifest(m), false);
  const partial = structuredClone(manifests.source); partial.coverage.state = "partial";
  assert.equal(validateManifest(partial), false); // A partial declaration needs an explicit limitation.
  assert.equal(validateManifest({...manifests.source, format_version:"future/2"}), false);
  assert.equal(validateNavigation({ ...fixture.span_segments[0], end_order: -1 }), false);
});
