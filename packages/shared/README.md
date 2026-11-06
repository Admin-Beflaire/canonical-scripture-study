# Shared helpers

Reusable native-reference and versification helpers belong here. This package must not import an application, perform storage access or execute preparation. Domain-specific builders and readers stay with their owning service.

This is the Workers' TypeScript implementation. Python preparation uses
`packages/shared-python/`. Both suites consume the same JSON conformance cases
in `tests/conformance/`; neither language implementation invokes the other.

The reference value follows `schemas/native-reference.v1.schema.json`: an exact source revision, coordinate version and ordered native segments. It is not a full evidence or D1 record. A source revision resolves its work, edition and representation through the Data records.

Offsets are integers in the declared coordinate profile. The scalar-text helper additionally checks a supplied text basis and Unicode-scalar bounds; it never treats JavaScript UTF-16 positions as native scalar positions. Other profiles need their own bounds checks. Strings and segment order are preserved without normalization.

Versification lookup consumes explicit in-memory mappings. It retains multiple targets, supplied target order, partial/disputed/missing/unresolved states and their basis. It does not infer equivalence from labels, invert mappings or choose a preferred disputed reading. Mapping storage and source adapters remain domain-owned.

