# Data preparation

Python module home: `src/css_preparation/`. It uses `css_shared` from
`packages/shared-python/` and the declarations in `schemas/`, and imports neither
Worker nor TypeScript runtime code. Standard library only.

| Module | Purpose |
| --- | --- |
| `validation` | Runtime check of the JSON Schema keyword subset used by `schemas/`. |
| `contracts` | Control's versioned job input and checkpoint/result envelopes. |
| `adapters` | Adapter declarations and resolution of declarative recipes (`collection/recipes/`). |
| `acquire.retention` | Exact-original input records, owner admission basis, blocking and storage routes. |
| `acquire.transfer` | Bounded transfer of one declared route; confined redirects, basis-checked resume. |
| `acquire.extract` | Confined ZIP/tar extraction with path, link, size and ratio limits. |

Preparation records the owner's admission decisions; it makes none. Unresolved
eligibility blocks the input. Originals go to `sources/` only with recorded public
redistribution; otherwise to protected storage. No source is chosen in code, and no
real acquisition runs from these modules without an owner-instructed Maintenance task.
