# D1 migrations

All domains use this single ordered migration sequence. `0001_evidence.sql` declares
the evidence/release tables from `schemas/evidence.v1.manifest.json`. Maintenance
Control adds its private task tables separately in this sequence.

The SQL creates tables, indexes and database integrity triggers. It includes no
acquisition, approval decision, quality executor, task orchestration or promotion
transaction. The statement guards enforce the single approved-record constraint;
they do not establish the authority of an approval reference.

D1 enforces foreign keys by default. Local SQLite tests enable them explicitly.
Each migration runs once in filename order through the deployment mechanism;
`CREATE ... IF NOT EXISTS` is deliberately avoided so drift or a duplicate apply is
reported. The initial selection row has no selected release. No live migration is
applied by adding this file or running the synthetic tests.

SQL uses SQLite/D1 JSON functions, strict tables, constraints and triggers. Consult
[D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
[JSON functions](https://developers.cloudflare.com/d1/sql-api/query-json/) and
[migrations](https://developers.cloudflare.com/d1/reference/migrations/) for the
provider execution contract. Local SQLite checks do not establish deployed D1 behaviour.

`0002_span_navigation.sql` adds ordered native-segment navigation and its
source/kind/start-order index. It extends the same migration sequence and preserves
selected-output immutability; preparation must verify complete segment coverage.

`0004_job_results.sql` adds `maintenance_jobs.result_json`, the accepted result envelope
Control uses to pass dependency outputs to later units and the candidate to quality.

`0005_reader_references.sql` adds output-scoped reader-reference baselines and
exception links. Mapping rows are prepared before release membership. Linking a
mapping output requires its exact catalogue version in the release metadata.
Existing releases without reader-reference outputs remain compatible with the
previous schema. Preparation verifies semantic mapping and complete selected
membership before use.

`0010_aid_entries.sql` adds `aid_entries`, one lookup row per language-aid entry: its
kind, entry key, lookup key and the byte position and digest of its line in the output's
entries file. Rows are immutable and, like other output rows, cannot change while the
output is selected. The wording and details are not in D1. Older annotation-based aid
rows stay until their outputs are replaced and removed.

`0011_drop_aid_json_indexes.sql` drops the four partial indexes on JSON expressions over
`annotations.details_json` that `0008` and `0009` added for language aids. Study reads
aids through `aid_entries` only, so nothing uses them; dropping them also makes the
removal of old aid rows cheaper.

`0012_compact_aid_keys.sql` stores one integer key per language-aid output and
uses it in the entry table and its lookup indexes. The `aid_entries` view keeps
the existing preparation record shape. Study uses indexed lookups with the same
text output IDs and cursor order.

`0013_annotation_source_metadata.sql` stores identical provider and basis
values for textual-variant notes once per source revision. The `annotations`
view reconstructs the existing records. Migration preserves existing notes and
leaves other annotation kinds inline.

Apply both migrations with the Control deployment and follow with the matching
Study deployment. The previous Study build uses an index hint against
`annotations` that SQLite cannot apply to a view. Keep these steps together in
a maintenance window. A code-only rollback must use a Study build compatible
with the migrated schema.

`0014_index_routes.sql` routes a search key to the index outputs that hold it.
`0015_release_index_summary.sql` stores, per release, source and capability, the
list of the index outputs the release selects, so a search reads one row instead of
scanning every output's coverage, membership and route rows. Control writes it in
the same step that stores the release's members. Study reads it only when the
release has one; an older release keeps the full scan until its summary is stored.
Apply the migration with the Control deployment before the matching Study
deployment: the new Study build reads the table when it opens a release.
