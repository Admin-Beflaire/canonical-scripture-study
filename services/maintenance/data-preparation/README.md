# Data preparation

Python module home: `src/css_preparation/`. It uses `css_shared` from
`packages/shared-python/` and the declarations in `schemas/`, and imports neither
Worker nor TypeScript runtime code. Standard library only.

| Module | Purpose |
| --- | --- |
| `validation` | Runtime check of the JSON Schema keyword subset used by `schemas/`. |
| `contracts` | Control's versioned job input and checkpoint/result envelopes. |
| `adapters` | Adapter declarations and resolution of declarative recipes (`collection/recipes/`). |
| `acquire.retention` | Exact-original input records, owner admission basis, blocking and storage routes. |
| `acquire.transfer` | Bounded transfer of one declared route; confined redirects, basis-checked resume. |
| `acquire.extract` | Confined ZIP/tar extraction with path, link, size and ratio limits. |
| `prepare.records` | Candidate evidence rows checked against `schemas/`, rendered as parameterised SQL in foreign-key order. |
| `prepare.evidence` | Source identities, exact native wording (D1 payload or registered R2 UTF-8 ranges), annotations, navigation rows, coverage and the reuse basis. |
| `prepare.literary` | Literary units (discontinuous, disputed with alternatives) and attributed relationships from admitted versification mappings. |
| `prepare.packages` | Source-only package refresh, incorporation of the one instructed approved statement, and dependency-aware rebuild plans. |
| `runner` | GitHub Actions entry (`python -m css_preparation.runner`) for one Control-dispatched job: Cloudflare REST storage, Control's internal job routes and the reviewed recipe registry. |

Preparation records the owner's admission decisions; it makes none. Unresolved
eligibility blocks the input. Originals go to `sources/` only with recorded public
redistribution; otherwise to protected storage. No source is chosen in code, and no
real acquisition runs from these modules without an owner-instructed Maintenance task.

## Preparation records

Adapters hand `prepare` a source identity, exact unit texts and the spans they
recognised. Wording is never normalised. A short single-segment body becomes a D1
text payload; longer or discontinuous bodies become digest-checked byte ranges in
one uncompressed R2 artifact per output. The size limit is a recipe parameter.
Every span gets `span_segments` rows: inclusive intervals in linear source order
(Unicode scalars across the revision's units in native order).

Output IDs derive from the complete reuse basis (inputs, method, parameters,
extent including the coordinate version, dependencies); reuse needs the whole
basis to match. Source-context coverage claims only units whose whole wording a
non-gap span exposes; anything else is reported as partial or missing. Mappings
link spans of one stated kind (for example verses) only through admitted mapping
rows, by exact native reference, never by verse number. Packages hold current source pointers only; a reference to a source that
is no longer held is dropped and reported, and a package with no held source is
omitted. Only the instructed owner-approved statement version is incorporated.

Preparation writes candidate rows only. It never writes releases, release
membership or `release_selection`; the executor (DP-04) performs the D1/R2 writes
and quality checks.

## Runner in GitHub Actions

`.github/workflows/prepare.yml` runs one job per dispatch on reviewed `main`: a
validate job routes the envelope to one fixed `acquire`, `prepare` or `quality`
job in the `preparation` environment. The runner reads the job from the event file,
never from a step environment or shell. Control also sends `dispatch_ref`, the job's SHA-256, which becomes the run title, and the runner refuses a job that does not match it. It writes D1 candidate rows through the
Cloudflare REST API (one batch per unit) and immutable private R2 objects, keeps
checkpoints under `prepared/checkpoints/` and quality receipts under
`prepared/receipts/`, and submits the result to Control
(`tests/conformance/internal-jobs.v1.json`). Public logs show only fixed status
lines; details stay in the private result. A job's `recipe_revision` must be
registered in `runner/recipes.py`; until source adapters are registered, jobs
end as `failed` with `no_registered_recipe`. A quality job names its candidate
in `constraints.candidate` (`added`, `reused`, `omitted` output IDs).

The `preparation` environment needs two secrets and six plain variables.

- Secret `PREPARATION_CLOUDFLARE_TOKEN`: one Cloudflare API token with **D1 Write** on the
  account (D1 cannot be scoped per database) and **Workers R2 Storage Bucket Item Read** and
  **Write** on the project's bucket only. D1 queries use the Cloudflare REST API. R2 objects use
  R2's S3-compatible API (`https://<account>.r2.cloudflarestorage.com`), signed with credentials
  derived from this token: access key ID = token ID, secret access key = SHA-256 of the token
  value. The REST API's R2 object endpoints would reject a bucket-scoped token (HTTP 403) and
  are rate limited per account, so the runner does not use them.
- Secret `PREPARATION_ACCESS_CLIENT_SECRET`: the Access service token admitted by Control's
  `/internal/jobs/*` application.
- Variables (not secret; they appear in run logs): `CONTROL_ORIGIN`,
  `PREPARATION_ACCESS_CLIENT_ID`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `R2_BUCKET` and
  `R2_ACCESS_KEY_ID` (the token ID; update it whenever the token is replaced).
