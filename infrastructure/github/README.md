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
