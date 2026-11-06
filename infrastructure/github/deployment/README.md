# Authorized application deployment

`deploy.yml` is manual only. A merge never deploys. An authorized assistant records
owner permission for the target and exact reviewed commit, then dispatches on
`main` with `target=study|control`, the 40-character `commit`, and `approval=DEPLOY`.
The confirmation word is an operator guard, not independent proof of review or
owner permission. Main protection, recorded review and restricted dispatch access
remain the authority boundary, as with provisioning.

The selected commit must be reachable from the trusted dispatch revision. The
workflow installs locked dependencies without lifecycle scripts or provider
credentials, builds only the selected Worker and renders the existing templates.
It does not download another run's artifacts or use dependency caches. A commit
predating `compatibility.json` is rejected. A reviewed code revert can use the same
path; do not restore an old data snapshot to revert code.

The trusted dispatch revision supplies the single forward `schemas/migrations/`
sequence, including for older selected application code. Wrangler applies it once
using D1's migration ledger before deploying routes. Already-applied migration
names absent from that sequence block deployment. Domain migration changes must
remain compatible with the serving application; this workflow cannot infer SQL
compatibility. `compatibility.json` at the selected application commit lists its
supported selected-release schema versions. Unknown/incompatible versions block
before migration/deployment. The current selection is read again after migration
and smoke checks; a concurrent change requires another compatibility check. The
runner issues no selection writes, data promotion or automatic data rollback.

## Protected environment setup

Restrict the `deployment` environment to trusted `main`. These are owner-entered
inputs, not public repository files. Do not place secrets at repository scope if
unrelated workflows could reach them.

| Input | Purpose |
| --- | --- |
| `DEPLOYMENT_INSTANCE_JSON` secret | Non-public instance values accepted by `infrastructure/cloudflare/render.mjs`; same shape as the synthetic fixture. |
| `DEPLOYMENT_CLOUDFLARE_TOKEN` secret | Worker deployment/settings readback, custom domains, D1 migration/query and required binding access for the intended account/resources. No GitHub/provider administration or preparation dispatch credential. |
| `DEPLOYMENT_STUDY_SMOKE_JWT` secret | Fresh owner-authenticated Access application token for Study, used as the Access cookie. |
| `DEPLOYMENT_CONTROL_SMOKE_JWT` secret | Equivalent token for Control's distinct host audience; only the selected token is supplied. |
| `DEPLOYMENT_DIAGNOSTICS_REPO` variable | Actual private design repository in `owner/name` form. |
| `DEPLOYMENT_DIAGNOSTICS_TOKEN` secret | Dedicated private-repository Contents read/write token for diagnostic release uploads/readback. |

Actual token scope/resource restrictions, environment enforcement and valid Access
sign-in must be recorded at authorized setup. D1 API access is not table-scoped.
Private-repository Contents write also permits other Contents/release changes,
including operational state assets; GitHub does not provide tag-scoped tokens.
This dedicated diagnostic token is supplied only to the trusted final upload step,
never build, Wrangler, smoke or preparation. It does not invoke state operations.
Preparation receives no deployment credentials. No secret is supplied to fork/PR
checks. Runtime secrets (for example Control's preparation dispatch token) remain
owner-managed Worker secrets and are not copied into rendered configuration.

## Results and failure handling

Provider/tool output is captured locally, then uploaded with digest verification to
the private `deployment-diagnostics` release using run/attempt-qualified names.
It is never a public Actions artifact. The private success receipt separates exact
commit/run, selected data and HTTP checks from actual host observations. A failure
has no success receipt; inspect private build/deployment logs. Migration/deployment
can have partial effects even if the workflow fails. A smoke failure does not
undo a deployment or change data selection. Repair or redeploy an authorized
compatible reviewed commit; never assume a failed deployment changed nothing.
If private upload fails, the run fails and detailed diagnostics may be unavailable;
local temporary files are removed in all ordinary completion paths.

Readbacks compare D1/R2 identities and runtime variables, and check that workers.dev
and preview access are disabled. Protected HTTP probes reject missing/invalid
credentials and authenticated login redirects. They negotiate every configured
legacy baseline candidate with enhancements either enabled or disabled, ping the
server and list tools where advertised. The existing transport scaffolds have no
domain tools. Core calls/continuation and real ChatGPT/Claude observations remain
application/CF-02 acceptance work; HTTP success never establishes that a shared
host baseline has been observed. CF-02 can deploy a representative fixture in the
selected Study or Control Worker through this same path, with intended resources
and migrations, rather than introduce a third application.

No workflow dispatch, provider mutation or live acceptance is performed by local
checks or by opening this PR.
