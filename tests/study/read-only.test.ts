import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../services/study/src/', import.meta.url);
const files = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : e.name.endsWith('.ts') ? [new URL(e.name, dir)] : []);

test('Study code writes nothing, dispatches nothing and holds no credentials', () => {
  const sources = files(root).map(url => [url.pathname, readFileSync(url, 'utf8')] as const);
  assert.ok(sources.length >= 10);
  for (const [path, text] of sources) {
    // No write paths: no D1 run/batch/exec, no R2 put/delete, no mutating SQL, no chat or answer storage.
    assert.doesNotMatch(text, /\.(run|batch|exec)\s*\(|\b(objects|PRIVATE_OBJECTS|bucket)\.(put|delete|createMultipartUpload)\s*\(/, path);
    assert.doesNotMatch(text, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\s+(INTO|TABLE|FROM|OR)\b/, path);
    // No outbound calls, dispatch or credentials; Maintenance is never reached.
    // A global fetch( is an outbound call; `handler.fetch(request)` passes the inbound request to the MCP handler.
    assert.doesNotMatch(text, /(?<![.\w])fetch\s*\(|GITHUB|\w*_TOKEN\b|\bTOKEN\b|SECRET|workflow_dispatch|services\/maintenance|data-preparation/, path);
  }
});
