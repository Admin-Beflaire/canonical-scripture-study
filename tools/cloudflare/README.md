# Study fixture measurement

This temporary Study entry runs the checked IX-01 synthetic source-text search.
It uses the ordinary Study route and verifies Access through the shared Worker
guard. The deployment-check identity retains discovery-only access.

## Local preparation

Run `python3 tools/cloudflare/study_fit_fixture.py <new-directory>`. The
generator checks all object lengths and digests, applies the repository migrations
to in-memory SQLite, and rehearses the insert, select, clear and delete stages.
The resulting SQL and object inventory are local files.

For local inspection, build the temporary entry separately from the deployable
Study bundle:

```sh
node_modules/.bin/esbuild tools/cloudflare/study-fit.ts --bundle --format=esm \
  --platform=neutral --conditions=workerd,worker,browser --target=es2023 \
  --outfile=dist/study-fit/index.js
```

The protected workflow writes its fit build to `dist/study/index.js`, which is
the path used by Wrangler. The ordinary Study build uses its normal entry.

## Protected run requirements

Use the reviewed deployment workflow with Study, the fit input, and the
`DEPLOY-FIT` marker for the temporary build. Use ordinary Study deployment
for restoration after clearing the fixture selection. Live orchestration must serialize with other operations on
the same instance and enforce these checks:

1. Confirm both selection pointers are empty and all fixture SQL identities
   and R2 keys are absent. Stop on a collision or any existing selection.
2. Stage the verified objects and fixture rows. Recheck selection before
   selecting the fixture. Abort unless precisely one selection row changes.
3. Use an authorized Study identity to call `fixture_search`. Record the
   expected three occurrences, D1 query counts and rows read, R2 requests
   and bytes, and the deployed revision. The fit deployment enables invocation
   logs at full sampling. Record the request timestamp and response correlation
   information privately, read the corresponding invocation's CPU time from
   Workers Observability, and record client elapsed time separately. Record
   unavailable counters as unknown. The ordinary deployment restores its
   existing logging configuration.
4. Clear selection only if it still identifies this fixture and the previous
   pointer is empty. Verify both pointers, restore the ordinary Study build,
   and remove the matching fixture rows and verified objects. Verify their
   absence and the protected smoke check. Stop for reconciliation
   on changed ownership, changed selection or uncertain writes.

The generator emits data and guarded pointer statements. It does not enforce
the live orchestration or perform provider operations.
