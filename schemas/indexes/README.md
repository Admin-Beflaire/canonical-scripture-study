# Search index contracts v1

These declarations describe immutable per-source text and word/language indexes.
Source text search works independently of cross-source acceleration. Lexicon text
has its own source index; attributed lemma-to-entry links remain D1 relationships
with independent relationship IDs and provenance receipts.

`manifest.v1.schema.json` identifies the prepared output, included source and
analysis revisions, checked native extent, coordinate version, normalization rule,
tokenizer version and parameters. Required analysis revisions must be present;
partial, missing or unresolved coverage cannot satisfy an available lookup.
The manifest coverage must agree with the output-scoped D1 coverage record, whose
`index_artifact_id` identifies the registered manifest artifact. The output must
belong to the selected release through `release_outputs`. File artifact IDs,
lengths and SHA-256 digests must agree with the artifact registry. Consumers reject
incompatible identities before using results.

## Postings and pages

Posting files are uncompressed UTF-8 NDJSON, with one complete JSON object and LF
per line, including the last line. Sort by unsigned UTF-8 bytes of `search_key`,
then numeric `native_order`, then unsigned UTF-8 bytes of `occurrence_id`.
A `(search_key, occurrence_id)` pair occurs once in an index. Empty normalized keys
are valid. Original wording is recovered through the immutable native reference;
normalization does not replace it. Word postings retain the form, admitted
analysis revisions, provider alternatives, grammar and attributed lemma IDs.
Consumers reject a posting if its `source_revision_id` or `coordinate_version`
differs from the corresponding value in its `native_reference`.

Each file directory records ordered, contiguous, non-overlapping, line-aligned
pages covering the entire file. Each page records inclusive first/last keys,
zero-based byte offset, positive byte length and SHA-256 digest. A key may span
several pages or files; consumers select every overlapping page in manifest order
and filter decoded rows for the exact key. Bounded continuation records progress
through those candidate pages and reports exhaustion only after all are consumed.
Whole-file identity and page identity are separate checks.

Before fetching, hashing or decoding a page batch, consumers check each encoded
length against the configured cap, each range against its file length, and the
sum against the request budget. Verify returned length and page digest before
strict UTF-8/JSON decoding. These are consumer obligations, not schema execution.
Production caps remain configurable pending the complete authenticated-path fit
measurement. The fixture's 2,048-byte page cap, 4,096-byte request budget and two
pages per request are synthetic examples only.

Initial capabilities are exact normalized word, form, lemma and grammatical-key
lookups. This version declares no phrase, proximity or fuzzy lookup capability.

## Span navigation

Apply `../migrations/0002_span_navigation.sql` after migration 0001. Each
`span_segments` row corresponds to one native segment, identified by its ordinal.
The source revision and kind must match the immutable parent span. Preparation
must supply all segment rows and verify their native order before selection;
SQL rejects out-of-range ordinals and mutation of selected navigation records.

Navigation intervals use inclusive source orders. Literary overlap is
`start_order <= query_end AND end_order >= query_start`, scoped by source revision
and kind, then by selected output membership. These orders are distinct from the
half-open Unicode-scalar offsets in native references. Existing relationship
member indexes support traversal in both directions.

## Fixtures and ownership

`../../tests/conformance/indexes/fixture.json` supplies small synthetic source,
word and lexicon indexes, registered artifact identities, output-scoped coverage,
independent link receipts and discontinuous literary spans. It is the minimal
permitted representative input for later fit measurement. The TypeScript schema
checks and Python local probes exercise compatibility, enumeration and bounded
consumption; they are not a production builder, remote reader or promotion path.
Maintenance owns index construction; Study owns runtime lookup and unsupported
capability responses. No source admission, live migration or deployment occurs
by adding these declarations or running the fixture tests.
