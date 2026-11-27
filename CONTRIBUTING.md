# Development

Use Node.js 24 and Python 3.12 (the checked patch version is recorded in
`.python-version`). Install the locked Node dependencies with `npm ci`.
Python tests use only the standard library. The code standard checks use Ruff,
installed with `python -m pip install --require-hashes --only-binary=:all: -r requirements-dev.txt`.

The pull request checks on GitHub are the test, so no local test run is needed.
`npm run check` runs everything, when that is wanted.

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


## Errors and logs

Every workflow, script and Worker reports a failure as one **error record**, built where the error is caught:
`css_shared.error_record` (Python) or `error-record.ts` in `packages/shared` (TypeScript). Both give the same JSON text.

- The record has the tool, stage, outcome, error class, our own error code, the code location (file, line, function),
  identifiers (unit, task, output, field), counts, HTTP status, provider error code and exit code.
- Only our own messages are stored. Make an exception class an `OwnMessage` (Python) or `OwnMessageError`
  (TypeScript) only when its message is fixed words and identifiers: it says what we were doing and which source, unit,
  position and field were wrong, never a piece of the source text (no `!r`, no slice of input). `test_error_messages.py`
  checks this for the preparation and shared code. Messages from libraries, providers and commands are never stored; the
  record keeps their class and status.
- Terraform and Wrangler output stays in a private file on the runner. `python3 -m css_shared.tool_log` turns it into
  records: a fixed message for the kind of failure (the tool's own wording is only matched, never printed), the resource
  address, and for a plan each resource's action and the names (never the values) of the attributes that change.
- Workflows print the record as a `::error` annotation (`annotation(record)`); Workers write it as a log line
  (`reportError`). Nothing else is printed, stored or deleted afterwards.


## Code standards

`npm run check:standards` checks the named standards as far as tools can: DRY,
Single Responsibility, composition, KISS and YAGNI, the Google TypeScript Style
Guide and PEP 8. Each check also runs on its own:

- `lint:ts` (ESLint with typescript-eslint) and `lint:py` (Ruff) report unused
  code, unsafe types, common bug patterns and functions over 15 branches
  (complexity) or over 80 lines (TypeScript) or 50 statements (Python).
- `format:ts` (Prettier, Google style options) and `format:py` (Ruff format).
- `check:duplicates` (jscpd) reports copied code in both languages.
- `check:baselines` fails when a baseline keeps a file that is missing or
  already formatted, or a copy that is gone, and when any exception list grew
  since the base commit (see below). `test:standards` tests that each check
  fails on a new problem.

Whether a function has one responsibility, is simple enough, or reuses the right
existing piece is still judged in writing and review. The reports are input for
that judgement.

Existing findings are recorded as a baseline, so only new problems fail. The
baseline only gets smaller, and the goal is that every list ends empty. No list
grows, whatever the size of the change: new code adds nothing to a list, and
`check:baselines` fails on a new list entry or ignore pattern (a folder or glob
in `.prettierignore`, `ruff.toml`, `.jscpd.json` or the ESLint ignores), a higher
suppression or copy count, and on a directive that switches a check off
(`eslint-disable`, `noqa`, `prettier-ignore`, `fmt: off`, `jscpd:ignore`) that
the file did not have at the base commit, counted per rule: adding a rule to a
`noqa`, a `noqa` without codes, or widening a next-line `eslint-disable` to the
whole file is growth. A list or config that is new compared with the base starts
from empty. A finding that formatting or a change reveals is fixed in that change,
never recorded. Code you touch leaves the lists smaller; a small fix (a few lines
in existing functions, no new function or file) need not empty its file, but
still adds nothing:

- ESLint findings are in `eslint-suppressions.json`. After fixing one, run
  `npx eslint --prune-suppressions`.
- Ruff findings are `# noqa` comments. Remove the comment with the fix; a `noqa`
  that no longer suppresses anything fails.
- Files not yet formatted are listed in `.prettierignore` and in the `[format]`
  `exclude` list of `ruff.toml`. A change that modifies a listed file must
  format it and remove it from the list; `check:baselines` fails otherwise, for
  committed and for uncommitted edits.
- Copied code is recorded in `.jscpd-baseline.json`. After removing a copy, run
  `npx jscpd --update-baseline`.

Public CI uses `tools/repository/run_test_profile.py` to run only what the
changed paths need, with the selected profiles at the same time. TypeScript runs
the test files that import a changed file, and all of them when a change is not
imported code; the tests of the standard checkers run only when the checkers or
their settings change. Shared schema/conformance changes run both
language consumers. Documentation-only PRs still complete the required
`Application checks` gate without rerunning application suites. Terraform checks
and mocked two-repository settings tests are described in `infrastructure/github/`.
