import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import catalogue from "../../schemas/reader-references/nrsva-1.json" with { type: "json" };
import catalogueSchema from "../../schemas/reader-references/catalogue.v1.schema.json" with { type: "json" };
import recordSchema from "../../schemas/reader-references/records.v1.schema.json" with { type: "json" };
import evidenceSchema from "../../schemas/evidence-records.v1.schema.json" with { type: "json" };
import nativeSchema from "../../schemas/native-reference.v1.schema.json" with { type: "json" };
import fixture from "../conformance/reader-references.v1.json" with { type: "json" };
import { readerAlias, readerBook, readerVerses } from "../../packages/shared/src/reader-catalogue.ts";
import aliasData from "../../schemas/reader-references/aliases.json" with { type: "json" };
import aliasSchema from "../../schemas/reader-references/aliases.v1.schema.json" with { type: "json" };
import aliasFixture from "../conformance/reader-aliases.v1.json" with { type: "json" };

const ajv = new Ajv({ strict: true, allErrors: true })
  .addSchema(recordSchema).addSchema(evidenceSchema).addSchema(nativeSchema);

test("NRSVA catalogue defines the versioned chapter bounds and separate books", () => {
  const validate = ajv.compile(catalogueSchema);
  assert.equal(validate(catalogue), true, JSON.stringify(validate.errors));
  const books = new Map(catalogue.books.map(book => [book.book_id, book]));
  assert.equal(books.size, 84);
  assert.equal(books.size, catalogue.books.length);
  assert.equal(catalogue.reader_scheme_version, fixture.reader_scheme_version);
  for (const book of catalogue.books) {
    assert.equal(book.chapter_count, book.last_verses.length);
    for (const [chapter, first] of Object.entries(book.first_verse_overrides ?? {}))
      assert.ok(first <= book.last_verses[Number(chapter) - 1]);
  }
  assert.deepEqual(books.get("Ps151")?.last_verses, [7]);
  assert.deepEqual(books.get("EpJer")?.last_verses, [73]);
  assert.equal(books.get("Bar")?.chapter_count, 5);
  assert.equal(books.get("Ps")?.chapter_count, 150);
  assert.equal(books.get("EsthGr")?.first_verse_overrides?.["11"], 2);
  assert.equal(books.get("Mal")?.last_verses[3], 6);
  assert.equal(books.get("Joel")?.last_verses[1], 32);
  assert.deepEqual(books.get("3John")?.last_verses, [15]);
  assert.equal(books.get("Rev")?.last_verses[11], 18);
  assert.equal(books.get("2Cor")?.last_verses[12], 13);
});

test("2 Corinthians 13 follows NRSVA, including its final verse", () => {
  const book = readerBook("2Co");
  assert.ok(book);
  assert.deepEqual(readerVerses(book, { chapter: 13, verse: 13 }, { chapter: 13, verse: 13 }), ["2Cor.13.13"]);
  assert.throws(() => readerVerses(book, { chapter: 13, verse: 14 }, { chapter: 13, verse: 14 }), /outside/);
});

test("reader aliases conform to the shared cases and target real catalogue verses", () => {
  const validate = ajv.compile(aliasSchema);
  assert.equal(validate(aliasData), true, JSON.stringify(validate.errors));
  assert.equal(new Set(aliasData.aliases.map(alias => alias.from)).size, aliasData.aliases.length);
  for (const alias of aliasData.aliases) {
    const [name, chapter, verse] = alias.to.split('.');
    const book = readerBook(name);
    assert.ok(book);
    assert.deepEqual(readerVerses(book, { chapter: Number(chapter), verse: Number(verse) },
      { chapter: Number(chapter), verse: Number(verse) }), [alias.to]);
  }
  for (const item of aliasFixture.cases) {
    const [name, chapter, verse] = item.reference.split('.');
    const book = readerBook(name);
    assert.ok(book);
    assert.equal(readerAlias(book, { chapter: Number(chapter), verse: Number(verse) })?.to ?? null, item.target);
  }
});

test("mapping records preserve the separate superscription, numbered span and unresolved reference", () => {
  for (const [kind, rows] of Object.entries(fixture.records)) {
    const validate = ajv.compile({ $ref: `${recordSchema.$id}#/$defs/${kind}` });
    for (const row of rows) {
      assert.equal(validate(row), true, JSON.stringify(validate.errors));
      assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
      assert.equal(validate({ ...row, unknown: true }), false);
    }
  }
  const validate = ajv.compile({ $ref: `${recordSchema.$id}#/$defs/reader_reference_link` });
  const [title, numbered, ambiguous] = fixture.records.reader_reference_link;
  assert.equal(validate({ ...title, reader_ref: "Ps.3.2" }), false);
  assert.equal(validate({ ...numbered, span_id: null }), false);
  assert.equal(validate({ ...ambiguous, gap_reason: null }), false);
  assert.equal(validate({ ...ambiguous, span_id: "numbered" }), false);
});

test("release metadata accepts the exact declared catalogue field and the pre-mapping shape", () => {
  const release = {
    id: "candidate", manifest_revision: "manifest", recipe_revision: "recipe",
    schema_versions_json: { evidence_records: "1" }, coverage_basis: "synthetic",
    quality_receipt: "quality", scope_receipt: "scope"
  };
  const validate = ajv.compile({ $ref: `${evidenceSchema.$id}#/$defs/release` });
  assert.equal(validate(release), true);
  assert.equal(validate({ ...release, schema_versions_json: {
    ...release.schema_versions_json, reader_scheme_version: fixture.reader_scheme_version
  } }), true);
  assert.equal(validate({ ...release, schema_versions_json: { reader_scheme_version: 1 } }), false);
});
