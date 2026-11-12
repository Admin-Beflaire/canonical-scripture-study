# Study search fit measurement

This temporary Study entry (`study-fit.ts`) runs Study's real read adapter and batch code
(`services/study/src/read`, `results`) against a staged synthetic fixture in the
`index-manifest/2` format with 16 KB pages. It uses the ordinary Study route and verifies Access
through the shared Worker guard. The deployment-check identity keeps discovery-only access.

The fixture (`study-fit-fixture.ts`) is deterministic and entirely invented: one synthetic source
revision, one source-search output whose search key `fitcommon` spans several pages, its three
registered objects under `synthetic/fit/`, and an **unselected** release `fit-release`. The real
current release stays selected and is never read or changed: the fit entry redirects only the
current-release read to `fit-release`; every other query, check and budget is production code.

## Local check

`node --test tests/platform/study-fit.test.ts` stages the fixture in local SQLite with all
migrations, runs the search to the end within the starting budgets, checks a corrupt object and
removes the rows. For local inspection, build the entry separately from the Study bundle:

```sh
node_modules/.bin/esbuild tools/cloudflare/study-fit.ts --bundle --format=esm \
  --platform=neutral --conditions=workerd,worker,browser --target=es2023 \
  --outfile=dist/study-fit/index.js
```

## Protected run

Use the reviewed deployment workflow with Study, the fit input and the `DEPLOY-FIT` marker. The
workflow refuses the fit build unless `fit-release` is staged and not selected. Restore with an
ordinary Study deployment.

1. Preflight: `fit-release`, the fixture row IDs and the `synthetic/fit/` keys are absent.
2. Stage the objects (verify length and SHA-256 after upload), then run the generated inserts.
3. Deploy the fit build. Call `fixture_search` through an owner-authorized Study connection,
   passing each returned continuation until none remains. Record hits, D1 calls and rows,
   R2 reads and bytes, response bytes, and each invocation's CPU time from Workers
   Observability, separately from elapsed time.
4. Restore the ordinary Study build and check the protected smoke check. Run the generated
   deletes, delete the objects and verify their absence. Stop for reconciliation on any
   unexpected row, object or selection change.

The generator emits data and delete statements. It does not perform provider operations.
