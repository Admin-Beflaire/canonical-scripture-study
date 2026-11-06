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
`log--<target>--<run>-diagnostics.txt` release asset. Inspect this private
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

**Not performed by this PR:** owner secret entry, baseline imports, real
Terraform plan/apply, state recovery or provider readbacks. Hosted CI covers
the protocol and static workflow contract; operational acceptance follows
an authorized live run.
