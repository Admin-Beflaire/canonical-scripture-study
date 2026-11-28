# Preparation recipes

Versioned preparation recipes belong here. They contain no credentials or restricted source bytes.

Each recipe is a JSON file matching `schemas/maintenance/recipe.v1.schema.json`: it
names a declared adapter and method version, the input format, parameters, native
extent, output capabilities and dependency inputs. Preparation resolves it against the
adapters' own declarations and rejects anything that does not fit.

## STEPBible TAHOT and TAGNT

STEPBible and language-aid recipes also list `task_inputs`: the inputs a task for them must name (STEPBible: the acquisition route and the source revision; language aids: the source revision). The adapter checks the list against its parameters. Acquire-only recipes need no list: their acquisition route is `manifest_revision` and their source revision is `native_extent.component`. Control's `get_recipe` returns these as a ready request, and blocks a task that leaves one out before anything runs.

`stepbible-fetch-<component>.json` fetches one pinned STEPBible-Data file for the
`stepbible-fetch` adapter: its single `acquire` unit keeps the original in protected private
storage only and registers its source revision and the admission record the recipe states in
`parameters.admission_record`. One fetch of a file serves every book in it. A fetch that finds
the original already kept verifies it and downloads nothing.

`stepbible-tahot-<book>.json` and `stepbible-tagnt-<book>.json` are one recipe per book for
the `stepbible-tagged` adapter. Each pins the same STEPBible-Data commit, file path, SHA-256 and
size as the fetch recipe of its file, and lists its units: `prepare-NN` (at most 300 verses
each, so one unit's rows fit one D1 batch) and `quality` over the whole book, which depends on
every prepare unit (at most 12, so at most 64 output references). It builds from the saved
original and never fetches. A task for one book names the recipe in `constraints.recipe` and
both inputs: the acquisition `stepbible-data:<commit12>:<component>` and the source
revision `stepbible-<tahot|tagnt>:<commit12>`, with the owner's admission decision.

A recipe says only how to do its step for that source. One task can chain the steps
(`steps: ["fetch", "build", "select"]`, with `constraints.fetch_recipe` and `constraints.recipe`);
Control's `get_recipe` answers with the requests to send for a recipe, in order, fetching an original that is not kept, and names the other build recipes over the same original and extent (recipe IDs that start with the same name, such as `…-reader`).

## Generated recipes

The source variables in [`collection/recipe-sources/`](../recipe-sources) pin
the original, book order and native coordinates. The fetch, text/search and reader
templates produce the committed recipe JSON at development time. Regenerate with
the standard library and the existing Preparation Python paths:

```sh
PYTHONPATH=packages/shared-python/src:services/maintenance/data-preparation/src \
  python -m css_preparation.generate_recipes
```

The pull request check compares the full generated values and rejects a change to
effective inputs under an unchanged recipe revision. Add a new source profile
when changing pinned STEPBible book order, base edition or provider. The initial
profiles keep the old output identities. Remove retired generated recipes
explicitly. Standalone recipes remain managed here.

Reader recipes keep every reader anchor's native contributors in one prepare
unit. If a balanced boundary splits contributors, move it to the beginning of
their chapter and check the resulting limits. The 1 Chronicles text recipe starts
prepare-03 at `1Ch.12.5`. Its reader recipe starts that unit at `1Ch.12.1` because
reader `1Chr.12.4` spans native `1Ch.12.4` and `1Ch.12.5`.

## World English Bible

`web-usfm-2020` registers the admitted publisher archive. The build recipes
`web-usfm-2020-<book>` read that retained archive and check the pinned archive and
member digests. They produce native passage text and exact word search. Psalm
descriptive titles have separate native spans and searchable text. The source
variables contain coordinates and digests only.

The Revelation reader recipe uses the source's verified numbering profile and
the listed offset exceptions. The evidence references in the source variables
identify the retained TVTMS and TAGNT inputs and the pinned CrossWire reference
metadata. The other books currently have native-text recipes.

## STEP language aids (B1)

Eight `stepdata-*.json` acquire-only recipes at the pinned STEPBible-Data commit:
TVTMS, TEHMC, TEGMC, TBESH, TBESG, TFLSJ 0–5624, TFLSJ extra and TIPNR.
TFLSJ has two upstream files and therefore two acquisition tasks. Each task
keeps one opaque original in protected R2; no parsing, building or release.
The acquisition receipt captures SHA-256 of the downloaded bytes.

## Character-of-God statement

`character-statement-0-2-fetch.json` (acquire-only) keeps the pinned statement file.
`character-statement-0-2.json` uses the `character-statement` adapter: one `prepare` unit
copies the file's fields into one statement record, and `quality` rebuilds that record from
the kept original and compares it. A task also needs the owner's statement approval (decision
kind `statement`, with the file's name and version) and, the first time, the admission decision.
