# GitHub configuration

Terraform 1.13.5 and the locked GitHub provider 6.13.0 manage settings for an
existing public application repository and a private design repository. Owner,
repository names, supported private protection and required check names are inputs.

## Validate without provider access

```sh
terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly -input=false
terraform validate
terraform test
```

Mocked tests render two account/repository input sets, check read-only Actions
without PR approvals, and reject an unprotected public application. They do not
contact the account API or apply settings.

## Adopt existing resources

Supply the two actual repository identities in the private Terraform inputs.
`adoption/imports.tf` declares imports for existing repositories, default
branches, Actions permissions, workflow permissions and enabled branch protections.
The protected provisioning workflow stages this as `imports.tf` **only** for
an authorized GitHub plan/apply; it is kept outside the normal Terraform root
so offline mocked `terraform test` does not attempt to import live resources. Check that each referenced remote object exists. The first
GitHub plan must propose **imports**, not creating/replacing repositories.
If an object is missing or its import identity differs, stop and reconcile
before any apply; do not remove an import just to make a plan pass.

If an earlier verified state already tracks one of these resources, Terraform
does not re-import it. Check that each object is mapped to only one state
address; reconcile the previous single-repository addresses with
`project["design"]`/`main["design"]` as needed. The provisioning
workflow handles protected state separately. An owner-approved empty baseline
does not authorize replacing existing repositories or permissions.

Check the plan for unexpected creation, deletion, replacement, visibility or
identity changes before applying it.

## Enforcement

Public `main` requires `Application checks` (the stable job name in `checks.yml`),
strict up-to-date checks, PRs, administrator enforcement and no force pushes or
deletions. The approving-review count is zero. Add the required check name after
its first successful hosted run. Rebase and auto-merge are disabled.

Set private protection only when the account plan supports it. The
`enforce_protection` input explicitly controls this resource.

Controls requiring setup outside the pinned provider:

1. Settings → Actions → General: read-only workflow permissions, no PR approvals,
   GitHub-owned actions and the exact pinned setup-terraform action.
2. Require full commit-SHA action pins where supported. Source policy tests check
   pinning independently of account enforcement.
3. Keep fork write tokens and secrets disabled; configure the available external
   contributor approval policy.
4. Restrict the later `preparation`, `deployment`, `provisioning` and `recovery`
   credential environments to trusted `main`. Checks use none of these environments.
   Privileged jobs rebuild trusted code and never consume PR artifacts, caches or
   chained `workflow_run` outputs.

## Public check execution

`checks.yml` creates its required gate on PRs and pushes to `main`. Internal path
routing skips unnecessary suites, so documentation-only PRs still complete the
gate. Shared schemas/JSON fixtures run both language suites; module changes run
their consumer. A wrong-language runtime file in a module runs all profiles so
both boundary checkers inspect it. Workflow/tool/config and unclassified executable
changes also run all profiles.

Checks use standard hosted Ubuntu runners with a 15-minute timeout. Actions and
tools are pinned, npm dependencies use the lockfile, npm lifecycle scripts/caching
are disabled, and checkout credentials are not persisted. Python helpers use the
standard library. Logs contain public code/fixtures and build/test output. Checks
accept no task/source/private inputs and upload no artifacts.

Extend routing tests with new domain modules and protocol-baseline,
optional-feature, search-capability and budget fixtures as they are implemented.

## GH-02 — lean protected provisioning (construction only)

`.github/workflows/platform.yml` is manual-only on trusted `main` under
the protected `provisioning` environment. Select the `github` or
`cloudflare` root, a reviewed 40-character SHA reachable from `main`,
and `plan` or `apply`. Apply also requires typing `APPLY`. A merge
never invokes Terraform.

Owner-entered environment settings:

- `PLATFORM_STATE_REPO` (variable): the **private-visibility** design
  repository's `owner/name`.
- `PLATFORM_STATE_TOKEN` (secret): dedicated access to its private
  `platform-state-v1` release, scoped to the design repository.
- `PLATFORM_GITHUB_TOKEN` and `PLATFORM_CLOUDFLARE_TOKEN`: target-specific
  provider credentials, made available only during Terraform plan/apply.
- `PLATFORM_GITHUB_TFVARS_JSON` and `PLATFORM_CLOUDFLARE_TFVARS_JSON`:
  selected Terraform inputs, supplied only during preparation.

Restrict the environment to trusted `main`, and verify actual secrets,
repository permissions and resource identities before the first operation.
Tokens and Terraform output never belong in public logs, PR comments,
source control or public Actions artifacts. The default Actions token is
read-only. State and diagnostics are **unencrypted private release assets**,
not Git files. Encryption of release assets is deliberately not part of GH-02.

### Execution and review

The workflow checks out the exact reviewed commit, but retains the state
helper from the trusted dispatch revision. It initializes the selected
Terraform root with its declared local backend, restores the last verified
state (if any), and runs a plan. Plan output is written to one private
`log--<target>--<run>--diagnostics.txt` release asset. Inspect this private
output and the target commit before separately authorizing an apply.

An apply dispatch makes its **own** plan and applies that plan during the
same run, after writing an attempt-qualified begin marker. A prior plan
dispatch is for information; it is *not* cryptographically bound to the apply.
Resource/state drift could change the plan between dispatches. When strict
change verification matters, obtain independent provider readbacks and
review the resulting private diagnostics before accepting the operation.

State is stored as `<target>--<run>--begin.json`,
`<target>--<run>--state.tfstate`, and
`<target>--<run>--receipt.json`. The helper uploads the state, downloads
it to verify its SHA-256, and records success or uncertain outcome. Both
targets have separate state identities; checked prior snapshots are retained.
All uploads are append-only **under client checks**, not immutable storage.

For a first run of **either** target, `initialize_empty_state` must be
explicitly owner-approved. It does not mean no resources exist. In particular,
the existing GitHub repositories and settings need reviewed Terraform
`import` blocks so the first plan adopts existing resources rather than
recreating them. Inspect existing private legacy assets and current live
resources first; the old encrypted `github-*`, `attempt-*` and
`complete-*` assets remain untouched. Do not interpret their presence as
a verified current state; no migration/encryption mechanism is added.

### Failure handling and private diagnostics

The workflow captures initialization, validation, plan and apply logs in a
**single private release asset**, including on failed runs. If apply has
begun, it attempts to preserve whatever nonempty state file Terraform left,
even when apply fails, with an uncertain receipt. Never publish raw logs.
A successful Terraform command is not a provider readback or deployment
acceptance; verify actual resources/settings separately.

An unfinished begin, missing snapshot or receipt, uncertain outcome,
invalid digest or unfamiliar new-protocol asset blocks further execution.
No automatic fallback to older state, deleting markers, or blind retry is
allowed. Repair is a separately owner-approved manual operation:

1. Stop new dispatches. Privately inspect the relevant release assets,
   diagnostics and preceding checked snapshot; check actual provider
   resources against their configurations.
2. If the attempt has a state snapshot, verify it against the actual
   provider resources before repairing its incomplete/uncertain receipt.
   If no state file exists (such as a failed first creation), rebuild an
   accurate state with reviewed imports against live resources; do not
   silently initialize empty again or replay a failed attempt.
3. Preserve the original assets and a private copy of the evidence. A
   separately reviewed reconciliation procedure must establish a trusted
   baseline and recorded outcome before provisioning resumes. The helper
   intentionally contains no force-reset or automatic repair command.

There is **no** Contents API rescue fallback and no state written into Git.
If GitHub release upload is unavailable after a resource mutation, the
updated runner-local state may be lost. Future runs stay blocked and
reconciliation from live resources is necessary. This residual risk is
accepted for the small free-first MVP; no extra backup service is implied.

### Release capacity

GitHub releases allow 1,000 assets. The helper reserves **four slots**
before apply: begin, snapshot, receipt, and one private diagnostics asset.
A plan-only dispatch adds one diagnostics asset. When capacity approaches
the limit, stop and migrate to a separately reviewed release/tag with
verified state baselines. Do not delete prior checked state or failed markers
just to free slots.

**Not performed by this PR:** owner secret entry, executing the declared imports, real
Terraform plan/apply, state recovery or provider readbacks. Hosted CI covers
the protocol and static workflow contract; operational acceptance follows
an authorized live run.

## Minimal recurring credential maintenance (7 November 2026)

The owner prefers one reusable GitHub credential and one reusable Cloudflare
account API token wherever supported, rather than a separate token per workflow.
The protected environment **secret names** remain distinct, even when their
values are the same; the existing dedicated GitHub tokens can be consolidated
when replaced with a credential having both Administration and design-repository
Contents write. No credential is changed automatically by this PR.

- GitHub Personal Access Tokens: GitHub Settings > Developer settings >
  Personal access tokens > Fine-grained. Renew the reviewed token and replace
  `provisioning/PLATFORM_GITHUB_TOKEN`, `provisioning/PLATFORM_STATE_TOKEN`,
  and `deployment/DEPLOYMENT_DIAGNOSTICS_TOKEN` if it is reused for all three.
  If still distinct, renew each one separately.
- Cloudflare Account API Tokens: Manage Account > Account API Tokens >
  `CSS Cloudflare Provisioning`. It is configured for account-wide Workers
  Admin, D1/R2 and Access Apps/Policies/Service Tokens, and all-zone DNS,
  Zone, Zone DNS Settings, Zone Settings and Workers Routes. Dashboard
  expiration as configured: **7 November 2027**. On renewal, replace the value
  in both `provisioning/PLATFORM_CLOUDFLARE_TOKEN` and
  `deployment/DEPLOYMENT_CLOUDFLARE_TOKEN`. Update future consumers too.
- Cloudflare Zero Trust > Access controls > Service credentials > Service
  Tokens: `CSS Internal Jobs` and `CSS Deployment Check` are non-expiring.
  If rotating a Client Secret, update its protected consumer only; do not
  confuse the service-token resource ID, Client ID, and Client Secret. Deployment
  uses `deployment/DEPLOYMENT_ACCESS_CLIENT_ID` (environment variable) and
  `deployment/DEPLOYMENT_ACCESS_CLIENT_SECRET` (environment secret).
- Never paste credential values in Git, issues, chat or logs. Check read-only
  permission/readback before revoking an old credential. Spending and adding
  credentials remain owner-reserved actions.

For the first Cloudflare plan, configure these **one-time environment
variables** in the trusted `provisioning` environment, not JSON:
`PLATFORM_CF_ACCOUNT_ID`, `PLATFORM_CF_ZONE_NAME`,
`PLATFORM_CF_ACCESS_ISSUER`, `PLATFORM_CF_OWNER_EMAIL`, and
`PLATFORM_CF_OAUTH_REDIRECT_URIS` (semicolon-separated, verified HTTPS
ChatGPT/Claude callbacks). Optional `PLATFORM_CF_INSTANCE` defaults to
`main`. Study/Control hostnames derive from the zone (study./control.),
while zone and service-token resource IDs are read from Cloudflare each run.
Missing/ambiguous identities stop the plan. The `github` Terraform target
continues using its already-configured static
`PLATFORM_GITHUB_TFVARS_JSON`; it needs no resource-ID copying.

The first plan needs separately authorized bootstrap/adoption and provider
verification. **This PR performs no Terraform plan/apply or deployment.**

### Verified state destination agreement

The `provisioning` environment variable `PLATFORM_STATE_REPO` and the
`deployment` environment variable `DEPLOYMENT_DIAGNOSTICS_REPO` **must point
to the same private repository**. Provisioning saves checked Cloudflare
Terraform state there; deployment restores it, and uploads its private
diagnostics under a separate release tag. An inconsistent repository will
block deployment or read the wrong state. Check both environment variables
at initial setup and after repository migration. Do not copy state into a
public artifact or hardcode its resource IDs.
