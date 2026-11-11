# Data preparation

Python module home: `src/css_preparation/`. It uses `css_shared` from
`packages/shared-python/` and the declarations in `schemas/`, and imports neither
Worker nor TypeScript runtime code. Standard library only.

| Module | Purpose |
| --- | --- |
| `validation` | Runtime check of the JSON Schema keyword subset used by `schemas/`. |
| `contracts` | Control's versioned job input and checkpoint/result envelopes. |
| `adapters` | Adapter declarations and resolution of declarative recipes (`collection/recipes/`). |
| `adapters.stepbible` | STEPBible TAHOT/TAGNT tagged-text adapter: reader, search rules and analyses, per-book evidence and indexes, pinned acquisition and admission records, recipe writer. |
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
(Unicode scalars across the revision's units in native order, or the order bases an
adapter declares for part of a revision; STEPBible uses book ordinal × 2^32 plus scalars
within the book, so one book is placed without reading the others).

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
lines; details stay in the private result. A job's `recipe_revision` must belong to a
reviewed recipe in `collection/recipes/` that resolves against a declared adapter
(`runner/recipes.py`); any other job ends as `failed` with `no_registered_recipe`.
Job inputs must be saved, except those the recipe itself declares: its acquisition
route, and the source revision that only its acquire unit creates. A quality job
names its candidate in `constraints.candidate` (`added`, `reused`, `omitted` output
IDs). Quality and checkpoint checks read only the candidate's own rows (by output,
through its spans and relationships, and its source ancestry), in pages and in
chunks of at most 90 bound IDs, never whole tables.

## STEPBible TAHOT and TAGNT

One recipe per book (`collection/recipes/stepbible-*.json`). The acquire unit fetches
the pinned file from `raw.githubusercontent.com` at its commit, checks size and SHA-256,
and keeps it under `originals/` in private R2 (the licence asks that copies are not
posted elsewhere). Prepare units of at most 300 verses each produce the verse evidence,
source search and word/lemma/grammar indexes in one D1 batch:

- Base text: TAHOT's translators' text (Leningrad following the Qere, with restored
  `R` and LXX-based `X` words as `restored` and `reconstructed` word spans); for TAGNT
  the words whose editions include NA28. Ketiv, other editions' words and recorded
  variants are attributed `textual_variants` annotations; a verse without base words
  is a gap.
- Wording joins the word cells (STEPBible's `/` and `\` separators removed) with one
  space, except after a Hebrew maqaf. Search keys: Hebrew without accents, meteg and
  puncta; Greek case- and accent-folded. Paragraph markers and punctuation are kept in
  the wording but are not tokens.
- Each tagged morpheme (Hebrew) or crasis component (Greek) is one attributed analysis
  with its lemma, so `lemma:` and `grammar:<language>:<code>` lookups find the word.

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
