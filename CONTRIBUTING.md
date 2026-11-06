# Development

Use Node.js 24 and install the locked dependencies with `npm ci`.

```sh
npm run check
```

The Study and Maintenance Control Worker scaffolds build independently:

```sh
npm run build:study
npm run build:control
npm run build:preparation
npm run build:shared
```

Build outputs are written to `dist/`. Both Worker scaffolds return HTTP 501; they are not functioning MCP servers and are not ready for deployment.

Study owns evidence retrieval. Maintenance Control owns tasks and release selection. Node preparation owns acquisition and indexing. Shared helpers import neither application, and Study must not import or call Maintenance. `schemas/` holds declarations and one D1 migration sequence.

Tests use synthetic fixtures. Do not commit credentials, generated indexes or source materials without public redistribution permission and required notices.

`npm run check:boundaries` checks imports, re-exports and dynamic imports across the application and Shared modules. JSON Schema checks and semantic reference tests run under `npm test`; their fixtures do not establish real source coverage or hosted behaviour.

