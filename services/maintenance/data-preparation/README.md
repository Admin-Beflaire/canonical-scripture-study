# Data preparation

Python module home: `src/css_preparation/`. Acquisition, builders, task execution
and storage writes are added by their domain packages; this scaffold performs none.
Preparation uses `css_shared` from `packages/shared-python/` and the declarations
in `schemas/`. It imports neither Worker nor TypeScript runtime code.
