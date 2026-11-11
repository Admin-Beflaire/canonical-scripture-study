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

The recipes are written by `python -m css_preparation.adapters.stepbible.recipes` from local
copies of the pinned files (see that module). They hold verse references, never wording.
