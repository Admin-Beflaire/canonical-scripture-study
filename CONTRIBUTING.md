# Development

Use Node.js 24 and Python 3.12 (the checked patch version is recorded in
`.python-version`). Install the locked Node dependencies with `npm ci`.
Python checks use only the standard library; no pip installation is needed.

```sh
npm run check
```

The Study and Maintenance Control Worker scaffolds build independently:

```sh
npm run build:study
npm run build:control
npm run build:shared
```

Build outputs are written to `dist/`. Both Worker scaffolds return HTTP 501; they are not functioning MCP servers and are not ready for deployment.

Study owns evidence retrieval. Maintenance Control owns tasks and release selection.
Python preparation owns acquisition and indexing. TypeScript Shared lives in
`packages/shared/`; Python common helpers live in `packages/shared-python/`.
Shared helpers import neither application, and Study must not import or call
Maintenance. `schemas/` holds declarations and one D1 migration sequence.

Tests use synthetic fixtures. Do not commit credentials, generated indexes or source materials without public redistribution permission and required notices.

`npm run check:boundaries` checks TypeScript and Python dependency directions and
rejects runtime files outside their known homes, executable Data declarations and
process/import bridges. These are static construction checks.
TypeScript checks tests/tools with Node.js types and checks both Workers and
Shared separately with Workers types.

`npm run check:python` imports the Python preparation and Shared modules.
`npm test` runs both suites against `tests/conformance/native-reference.v1.json`,
including native-reference, scalar-extraction and versification cases.
The quoted TypeScript test pattern discovers nested test folders. Fixtures do not
establish real source coverage or hosted behaviour.

The Python runner selects `python3` on Unix or `python` on Windows. Set
`PYTHON` to an interpreter executable path when needed; no shell command is used.


Public CI uses `tools/repository/run_test_profile.py` to route TypeScript,
Python and repository checks by changed paths. Run `npm run check:repository`
for routing/credential-boundary tests. Shared schema/conformance changes run both
language consumers. Documentation-only PRs still complete the required
`Application checks` gate without rerunning application suites. Terraform checks
and mocked two-repository settings tests are described in `infrastructure/github/`.
