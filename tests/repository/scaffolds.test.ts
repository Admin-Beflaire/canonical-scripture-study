import test from "node:test";
import assert from "node:assert/strict";
import study from "../../services/study/src/index.ts";
import control from "../../services/maintenance/control/src/index.ts";

for (const [name, worker] of [["Study", study], ["Control", control]] as const) {
  test(`${name} scaffold exposes no working route`, async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await worker.fetch(new Request("https://example.invalid/mcp", { method }));
      assert.equal(response.status, 501);
    }
  });
}
