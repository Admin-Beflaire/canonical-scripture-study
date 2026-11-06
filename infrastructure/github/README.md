# GitHub configuration

Terraform 1.13.5 and the locked GitHub provider 6.13.0 declare settings for an
existing public application repository and a private design repository. Owner,
repository names, supported private protection and required check names are inputs.
No credentials, account identifiers or private repository contents belong here.

## Validate without provider access

```sh
terraform fmt -check -recursive
terraform init -backend=false -lockfile=readonly -input=false
terraform validate
terraform test
```

The tests use a mocked provider. They render two account/repository input sets,
check read-only Actions without PR approvals, and reject an unprotected public
application. They never create repositories, contact the account API or apply settings.

## Existing-resource adoption

Copy `example.tfvars.example.json` to an ignored local input file and set real
identities privately. Both existing repositories must be adopted before an apply;
this configuration is not a repository-creation instruction. Preserve the protected
state and reconcile existing resources first. Existing single-repository addresses
must be migrated to their matching `project["design"]`/`main["design"]` addresses;
import the application and newly managed permissions/protection with observed IDs.
The protected provisioning/state workflow supplies this operation separately.
Never apply a fresh empty local state against the live repositories.

After an authorized plan, require no unexpected creation, deletion, replacement,
visibility change or identity change. Review the exact plan before an authorized
apply. Merging this configuration does not apply it.

## Enforcement and setup receipt

Public `main` requires `Application checks` (the stable job name in `checks.yml`),
strict up-to-date checks, PRs, administrator enforcement and no force pushes or
deletions. Independent review is recorded by attributed comments; a second GitHub
account approval is not required. Wait for a successful hosted check before adding
its name to branch protection. Rebase and auto-merge remain disabled.

Private protection is enabled only if the actual account plan supports it. When
unavailable, record that limitation and retain the PR/review/owner-authorized merge
procedure. Never claim that a procedural safeguard is provider enforcement.

Some controls require explicit setup/readback outside this pinned provider:

1. Settings → Actions → General: read-only workflow permissions; no PR approvals;
   permit GitHub-owned actions and the exact pinned setup-terraform action.
2. Require actions pinned to full commit SHAs where the account offers this policy.
   The source policy tests enforce pins independently of that setting.
3. For fork PRs, keep write tokens and secrets disabled. Apply the available external
   contributor approval policy; do not approve a privileged workflow as a substitute.
4. Later credential environments are `preparation`, `deployment`, `provisioning` and
   `recovery`, restricted to trusted `main`. They are not created by this package.
   Checks name no environment, receive no provider/private tokens, and publish no
   artifacts or reusable caches. Privileged jobs must rebuild reviewed trusted code;
   they must not chain from PR checks, artifacts or `workflow_run`.
5. Record date, repository ID, account plan, observed values, unsupported settings,
   exact applied configuration and readback method privately. Credentials remain
   owner-entered; setup is an independently authorized operation.

## Public check execution

`checks.yml` always creates the required gate on PRs and pushes to `main`. Internal
path routing skips unnecessary suites, avoiding required checks stuck pending after
an event-level path filter. Shared schemas/JSON fixtures run both language suites;
module changes run their consumer; workflow/tool/config changes run all profiles.
New unclassified executable/configuration files fail closed to all profiles.

Only standard hosted Ubuntu runners are used, with a 15-minute timeout. Dependencies
are locked, npm lifecycle scripts and package-manager caching are disabled, and
checkout credentials are not persisted. Python helpers use the standard library.
Run logs contain only already-public code/fixtures and ordinary build/test output;
no task/source/private input is accepted. No artifact upload or provider operation
exists. Runner timestamps provide actual duration; artifact storage is zero for this
workflow. Record public-repository billing rules and actual account allowances
separately from private minutes; refusal stops execution without a paid fallback.

Extend routing/tests with future domain modules and protocol baseline, optional
feature, search capability and budget fixtures. This foundation does not invent
those not-yet-implemented domain tests.
