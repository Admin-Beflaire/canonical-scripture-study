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

Copy `example.tfvars.example.json` to an ignored local input file and set the
repository identities. Reconcile existing resources and protected state first.
Migrate existing single-repository addresses to their matching
`project["design"]`/`main["design"]` addresses, then import the application and
newly managed permissions/protection with their observed IDs. The provisioning
workflow supplies state handling separately. Do not apply an empty local state
against existing repositories.

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

## GH-02 protected provisioning (construction only)

`.github/workflows/platform.yml` is manual-dispatch only, restricted to trusted
`main` and the protected `provisioning` environment. Dispatch selects the
`github` or `cloudflare` Terraform root, a full SHA already merged into
`main`, and either `plan` or `apply`. Apply additionally requires the literal
`APPLY` confirmation. A merge NEVER triggers plan/apply. All Terraform/provider
output stays in the short-lived runner and is not emitted in public Actions logs.

Configure environment secrets (owner-entered, never copied to Git):

- `PLATFORM_STATE_TOKEN`: separate private design repository Contents write token
  capable of reading/writing assets in its operational release.
- `PLATFORM_GITHUB_TOKEN`: GitHub settings provisioning identity, scoped to
  approved repositories and privileges (not the default Actions token).
- `PLATFORM_CLOUDFLARE_TOKEN`: Cloudflare account resource-management identity.
- `PLATFORM_GITHUB_TFVARS_JSON` and `PLATFORM_CLOUDFLARE_TFVARS_JSON`:
  separate validated Terraform input JSON objects with owner-supplied values.

Set environment variable `PLATFORM_STATE_REPO` to the **private** design
repository's `owner/name`. Restrict the provisioning environment to trusted
`main`; record actual token permissions, supported environment enforcement,
account plan and provider readbacks privately before the first operation.
The default Actions token stays read-only. Never pass values in dispatch
inputs, workflow logs or public artifacts. The existing and historical states
must be inventoried and imported/adopted first, not overwritten.

The state protocol in `platform_state.py` uses the design repository's
`platform-state-v1` operational release and independent `github`/`cloudflare`
state names. Every apply writes a unique begin marker **before** mutation.
It uploads a state snapshot and verifies its downloaded digest, then writes
an append-only success/uncertain receipt under client-side duplicate checks.\nAny missing snapshot/receipt, failed
apply, unrecognized state asset or digest mismatch **blocks future runs**;
do not fall back to older state or delete a failed marker to clear the error.
Reconcile actual resources and state independently first. Preserve the
preceding checked snapshot. No state is placed in public source, Actions
artifacts or recovery bundles.

The initial Cloudflare state may be empty **only** when the owner separately
authorized first creation and the external resource inventory proves those
resources absent; dispatch `initialize_empty_cloudflare` to opt in. GitHub
state is never initialized empty: adopt/import the already-existing repo
settings into a checked private snapshot before applying. A workflow
`plan` does **not** produce publicly reviewable changes or authorize apply;
provider configuration and plan must be assessed through the approved
private-channel process. A successful run means the Terraform command
completed and the state was checked, **not** that provider drift, actual
permissions, Worker deployment, or host authentication were verified.

Current GH-02 limitations requiring separate operational acceptance:
the first private release and baseline adoption require operator setup;
uncertain state requires a reviewed manual reconciliation procedure; and
provider readbacks must be performed on the actual authorized first
apply. No Cloudflare or GitHub apply is triggered by this PR.

## Release capacity and recovery

GitHub releases permit at most 1,000 assets. Before beginning an apply, the
state helper requires three free slots for its begin marker, verified state,
and terminal receipt. When capacity is low, **do not delete history in place**
or bypass the check. Freeze provisioning, preserve a private export of the
complete release and verified per-key baselines, reconcile both roots against
live resources, and establish a separately reviewed new release protocol/tag
with migrated baselines before resuming. Record the migration and verify both
roots by private readback. Earlier workflow attempts must not be rerun after
newer successful applies; start a fresh dispatch instead.

The current dispatch revision owns the state helper even when Terraform is
checked out from an older approved commit. Only the selected target's provider
credentials are exposed to the workflow, while the private-state credential is
limited to state-management steps. Provider commands do not receive the
state-repository token.

Terraform initialization, validation, planning and applying execute in a\nrestricted container with only the selected configuration directory mounted.\nThe trusted state helper and state token stay on the host, outside the container.\nProvider processes therefore do not inherit state-write authority. This\ncontainer boundary does not replace review of provider binaries and scopes.\n