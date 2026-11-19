# Preparation recipes

Versioned preparation recipes belong here. They contain no credentials or restricted source bytes.

Each recipe is a JSON file matching `schemas/maintenance/recipe.v1.schema.json`: it
names a declared adapter and method version, the input format, parameters, native
extent, output capabilities and dependency inputs. Preparation resolves it against the
adapters' own declarations and rejects anything that does not fit.

## STEPBible TAHOT and TAGNT

`stepbible-tahot-<book>.json` and `stepbible-tagnt-<book>.json` are one recipe per book for
the `stepbible-tagged` adapter. Each pins its STEPBible-Data commit, file path, SHA-256 and
size, and lists its units: `acquire` (the pinned file, kept in protected private storage
only), `prepare-NN` (at most 300 verses each, so one unit's rows fit one D1 batch), and
`quality` over the whole book, which depends on every prepare unit (at most 12, so at most
64 output references). A task for one book names the recipe in `constraints.recipe` and
both inputs: the acquisition `stepbible-data:<commit12>:<component>` and the source
revision `stepbible-<tahot|tagnt>:<commit12>`, with the owner's admission decision.

A recipe stays one file. Control runs it as separate tasks: an `acquire` task runs only the
recipe's `acquire` unit and keeps the original; a build task (prepare, correct, replace) runs the
`prepare` and `quality` units and never fetches, using the kept original of a finished acquire task
named in `constraints.acquired`; a `release` task then makes the checked build current.

The base recipes are written by `python -m css_preparation.adapters.stepbible.recipes` from local
copies of the pinned files (see that module). They hold verse references, never wording.

The committed `-reader.json` recipes are maintained separately. Use the same pinned
input and ordered book extent as the base recipe, but keep every reader reference
within a single prepare unit. Preserve reviewed reader boundaries when regenerating
base recipes. In 1 Chronicles, the reader recipe starts prepare-03 at native
`1Ch.12.1` because reader `1Chr.12.4` spans native `1Ch.12.4` and `1Ch.12.5`.
Bump the reader recipe revision when its prepare partition changes so an existing
task stays tied to the partition it started with.
