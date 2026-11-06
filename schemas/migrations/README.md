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
