import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { checkSource } from "../../tools/check-boundaries.mjs";

const root = resolve(import.meta.dirname, "../..");
test("Study cannot reach Maintenance through imports, exports or dynamic imports", () => {
  const target = "../../maintenance/control/src/index.ts";
  for (const source of [
    `import value from "${target}";`, `export { default } from "${target}";`,
    `import("${target}");`, `type Value = import("${target}");`,
    "import(computed);", `require("${target}");`,
  ]) assert.ok(checkSource(root, "services/study/src/index.ts", source).length, source);
});

test("Shared cannot import an application and Maintenance cannot import Study", () => {
  assert.ok(checkSource(root, "packages/shared/src/index.ts", 'import "../../../services/study/src/index.ts";').length);
  assert.ok(checkSource(root, "services/maintenance/control/src/index.ts", 'import "../../../study/src/index.ts";').length);
  assert.ok(checkSource(root, "services/maintenance/data-preparation/src/index.ts", 'import "../../../study/src/index.ts";').length);
});

test("applications can consume Shared and Shared can consume declarative schemas", () => {
  assert.deepEqual(checkSource(root, "services/study/src/index.ts", 'import "../../../packages/shared/src/index.ts";'), []);
  assert.deepEqual(checkSource(root, "packages/shared/src/references.ts", 'import "../../../schemas/native-reference.v1.schema.json" with { type: "json" };'), []);
});
