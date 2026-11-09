# Preparation recipes

Versioned preparation recipes belong here. They contain no credentials or restricted source bytes.

Each recipe is a JSON file matching `schemas/maintenance/recipe.v1.schema.json`: it
names a declared adapter and method version, the input format, parameters, native
extent, output capabilities and dependency inputs. Preparation resolves it against the
adapters' own declarations and rejects anything that does not fit.
