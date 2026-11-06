# Cloudflare construction

Terraform 1.13.5 / Cloudflare provider 5.28.1 own one D1 database, one private R2
bucket, disabled managed public access, two owner-only Managed OAuth resources
and a more-specific Service Auth resource at Control `/internal/jobs/*`.
An existing Access service-token **ID** is an input; its credentials are issued
separately and stay in protected runner secrets. No secret generation or Worker
resource is managed by this Terraform root. Its state must use the protected
provisioning path before any real plan/apply; never archive state with source.

Wrangler 4.158.0 alone owns Worker code, runtime flags, bindings, custom-domain
registration and disabled workers.dev/preview routes. `schemas/migrations/` is
the single SQL sequence, applied by the authorized deployment workflow.
Terraform does not apply SQL or duplicate Worker/domain/DNS settings.

## Instance inputs

`render.mjs` accepts a protected JSON file with exactly these fields:

| Fields | Meaning |
| --- | --- |
| `ACCOUNT_ID`, `ZONE_ID`, `ZONE_NAME`, `INSTANCE` | Destination account, zone and suffix |
| `STUDY_HOSTNAME`, `CONTROL_HOSTNAME` | Distinct custom hostnames inside the zone |
| `DATABASE_ID` | Terraform-created database |
| `ACCESS_ISSUER` | HTTPS Access team issuer |
| `STUDY_AUDIENCE`, `CONTROL_AUDIENCE`, `JOB_AUDIENCE` | Distinct Terraform-created application audiences |
| `ENHANCEMENTS` | Boolean; start false, test newer protocol separately |
| `MAX_PAGE_BYTES`, `REQUEST_BYTES`, `MAX_D1_CALLS`, `MAX_SUBREQUESTS`, `CPU_BUDGET_MS` | Positive bounded settings, measured before production retrieval |

The database/bucket names use the same `INSTANCE` suffix as Terraform. Terraform
additionally takes `owner_email`, `hostnames`, `oauth_redirect_uris` and the
existing `job_service_token_id`. Verify the intended ChatGPT/Claude callback URIs
when setting up those protected inputs; wildcard localhost registration is off.
Do not put account values, owner identity, credentials or rendered files in Git.
The checked-in `tests/platform/instance.fixture.json` is synthetic, not an instance.

From the repository root, build then render:

```sh
npm run build
node infrastructure/cloudflare/render.mjs /protected/instance.json
npx --no-install wrangler deploy --dry-run --config dist/config/study.json
npx --no-install wrangler deploy --dry-run --config dist/config/control.json
```

Rendering uses the committed `wrangler.jsonc` templates beside the entry points;
relative bundle/migration paths are based on the fixed ignored `dist/config/`
output location. Unresolved, missing, duplicated resource identities, unknown
inputs and inconsistent budgets fail before writing. Templates are not directly
deployable. No real deployment follows from the dry run or merging this code.
Regenerate binding declarations with `wrangler types --config dist/config/<role>.json
--env-interface StudyEnv|ControlEnv --include-runtime false --strict-vars false`.
Generate these into ignored `dist/types/` when consumers need binding types;
keep instance-derived declarations out of Git. Current Platform code types only
the authentication settings it consumes, without duplicating D1/R2 bindings.

## Authentication and protocol

Shared Platform code verifies RS256 signature, issuer, intended audience and
required expiration/issued-at claims using the trusted issuer's Access JWKS.
JWKS caching contains keys only, never request identities. The Worker checks
HTTPS/custom hostname, Host and Origin before accepting `/mcp`; only Control
accepts the job path, with its distinct job audience. Error responses reveal no
assertions, keys or validation details. Unconfigured Workers fail closed.
Managed OAuth metadata/login/registration are supplied by Access, not these
Worker routes. Direct calls to the origin cannot use a login redirect as proof
of authentication. No source/object locator is a public route.

Official `@modelcontextprotocol/server` 2.4.0 serves fetch-native Streamable HTTP.
Enhancements off uses its bounded stateless legacy adapter: 2025-03-26,
2025-06-18 and 2025-11-25 are locally tested candidate baselines, **not a confirmed
common-host baseline**. Enhancements on adds the SDK's 2026-07-28 entry while
retaining legacy handling. Tests use fixture tools for discovery, calls, readable
results and application cursor continuation. Production servers have no domain
tools yet; job operations return 501 until Control supplies them. Study/Maintenance
packages own domain tools and actual sign-in/host acceptance. Node tests and
bundling alone do not establish workerd execution or either host's support.

## Permissions and setup readbacks

| Consumer | Inputs and actual scope to verify before use |
| --- | --- |
| Study | D1/R2 bindings and auth/budget settings only; no dispatch/deploy/admin token |
| Control | Same bindings, separate host/job audiences; later fixed-workflow dispatch token |
| Preparation | D1 API candidate writes, bucket-scoped R2 object credentials, internal-job Access token; no deploy/Terraform token |
| Provisioning | D1 Write, Workers R2 Storage Write, Access Apps and Policies Write for intended account; state protected separately |
| Deployment | Workers Scripts Write and required route/custom-domain zone access; separate from preparation |
| Export | Only required D1 read/export and bucket object reads; separate workflow authority |

D1 grants/bindings do not isolate individual tables and R2 object credentials do
not enforce candidate prefixes. Study read allowlists and Preparation candidate
writes are application obligations. No stronger provider isolation is claimed.
Before exposing usable routes, provision resources/Access, render their outputs,
then deploy independently and read back resource IDs, audiences, owner and job
policies, bindings, disabled workers.dev/previews, and R2 public/custom domains.
Reject missing/wrong audience/issuer/expiry, cross-role and direct/preview calls.
Do not attach public custom domains to the bucket. Verify provider permissions
with the actual separate tokens; the development connector's inventory access
does not establish runner token scope. Live setup/readbacks belong to authorized
provisioning/deployment and early-fit packages.

Configured budget ceilings are conservative guards, not capacity measurements or
an upgrade path: at most 10 ms CPU, 50 D1 calls and 50 total subrequests. Consumer
budgets include authentication work and leave headroom; page/result/query sizes
are measured on the complete authenticated path before production retrieval.
Logs/traces use Cloudflare's existing facilities; invocation logging is disabled.
Only redacted structured diagnostics may be added, without assertions or secrets.

References checked 6 November 2026:
[Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[Worker JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[SDK runtime adapter](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard),
[SDK versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions),
[provider 5.28.1 application schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.28.1/docs/resources/zero_trust_access_application.md).
