# Python Shared helpers

The Workers use TypeScript Shared; preparation uses this small Python equivalent.
Both consume the versioned declarations in `schemas/` and the same synthetic JSON
conformance cases in `tests/conformance/`. Helpers load the schema from this
repository's source tree and have no third-party Python dependencies.

This package contains no source adapter, builder, reader, storage access or
application execution. Source revision and coordinate identities remain exact;
strings and supplied mapping order are never normalized or inferred from labels.
