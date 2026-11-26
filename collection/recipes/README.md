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
storage only and registers its source revision and admission. One fetch of a file serves every
book in it.

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
Control's `get_recipe` answers with the request for a recipe and the fetch recipe its original needs.

The fetch recipes and the base book recipes are written by
`python -m css_preparation.adapters.stepbible.recipes` from local copies of the pinned files
(see that module). They hold verse references, never wording.

The committed `-reader.json` recipes are maintained separately. Use the same pinned
input and ordered book extent as the base recipe, but keep every reader reference
within a single prepare unit. Preserve reviewed reader boundaries when regenerating
base recipes. In 1 Chronicles, the reader recipe starts prepare-03 at native
`1Ch.12.1` because reader `1Chr.12.4` spans native `1Ch.12.4` and `1Ch.12.5`.
Bump the reader recipe revision when its prepare partition changes so an existing
task stays tied to the partition it started with.

## STEP language aids (B1)

Eight `stepdata-*.json` acquire-only recipes at the pinned STEPBible-Data commit:
TVTMS, TEHMC, TEGMC, TBESH, TBESG, TFLSJ 0–5624, TFLSJ extra and TIPNR.
TFLSJ has two upstream files and therefore two acquisition tasks. Each task
keeps one opaque original in protected R2; no parsing, building or release.
The acquisition receipt captures SHA-256 of the downloaded bytes.
