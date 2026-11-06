# Data declarations

`evidence.v1.manifest.json` locates the record contracts, shared native-reference
schema and single D1 migration sequence. `evidence-records.v1.schema.json` defines
named records under `$defs`; consumers validate against the appropriate definition
(for example `urn:css:evidence-records:1#/$defs/native_span`). Extra record fields
are rejected. No executable application or source collection is defined here.

JSON-column fields (`*_json`) contain decoded objects/arrays in these contracts;
SQL adapters serialize them as UTF-8 JSON text. JSON booleans become SQLite 0/1.
The native-reference schema remains the common TypeScript/Python identity contract.
Source-specific `details_json` and versioned method/coordinate identifiers preserve
provider-specific information without adding a table for each source.

## Record boundaries

- Work, edition, representation and exact source revision have separate identities.
  Admissions assess each component, both-host eligibility and public redistribution
  independently. A schema-valid synthetic row is not an actual source admission.
- Prepared outputs identify exact inputs, method/version, parameters, extent and
  validation basis. Artifacts retain byte digest/size/format and a portable object
  key. Original artifacts have no output; generated artifacts name their output.
  Bucket/account bindings are separate configuration, never part of the stored key.
- D1 text payloads use SHA-256 content IDs; sharing bytes does not merge source
  identity or attribution. Native spans use the exact source/coordinate basis and
  ordered segments. Their body is a D1 payload, registered R2 ranges, or an explicit
  gap. R2 ranges map segment ordinals to bounded, uncompressed UTF-8 bytes and their
  digests; long non-biblical bodies belong in R2.
- Annotations and ordered relationship members retain attribution, uncertainty,
  direction, gaps and multiple endpoints. Bulk word occurrences/grammar belong in
  the separate index formats, not in these D1 records.
- Coverage belongs to an output rather than a release, so it can be prepared early
  and reused. Each row covers one capability/revision for that output; its extent
  object can include multiple native units/segments. Missing/partial/unresolved
  states retain limitations.
- Study packages hold attributed source references and dependencies. External/not-held
  references carry a locator, never an invented held revision. No answer field or
  general findings/teachings acceptance mechanism exists.
- Character statements retain a named/versioned approval reference and Scripture
  basis. Synthetic approval references in tests have no operational authority.
  Statement metadata must precede release membership; only an approved record can
  be included, with at most one per release. The statement is a conclusion check.

## Selection and validation

`release_outputs` provides indexed membership; unchanged outputs can belong to
multiple releases. The seeded `release_selection` singleton has null current/previous
IDs before the first release. Maintenance selects a checked compatible release in
one transaction, retaining the previous selection for operational rollback. Study
resolves current once per request and restricts each evidence read to that membership.
These declarations perform no promotion and add no per-read permission engine.

Validate named JSON records before writing them. SQL enforces foreign keys, source
hierarchy, JSON column containers, body alternatives, selection shape and statement
membership integrity. JSON Schema checks nested record shapes and safe scalar types.
Neither alone establishes semantic source bounds, input/dependency existence inside
JSON, body-range artifact/segment alignment, hash correctness, complete admission,
release-wide endpoint membership or format compatibility. Maintenance quality/scope
checks must establish those properties before selection, including the recorded
both-host eligibility of each admitted component. An opaque receipt reference does
not prove that a check passed. Records and referenced outputs/payloads/artifacts are
immutable preparation results; changed evidence gets new identified outputs.
Study's later adapter supplies bounded authenticated reads and digest verification.

## Construction checks

The same permitted synthetic fixture in `tests/conformance/evidence-records.v1.json`
is consumed by TypeScript schema/native-reference checks and Python SQLite/native
reference checks. It tests two releases, reused output coverage, ordered multi-endpoint
relationships, exact UTF-8 ranges, per-component admission distinctions, portable keys,
source-only packages, statement selection and transaction failure preserving current.
These fixtures neither apply a D1 migration nor access R2 or admit actual sources.

Run `npm run check`. Provider deployment/configuration, real-source preparation,
index encodings and application read/write behaviour are supplied separately.
