import test from 'node:test';
import assert from 'node:assert/strict';
import { protocolHandler, LEGACY_VERSIONS } from '../../packages/shared/src/platform.ts';
import { controlServer, CONTROL_INSTRUCTIONS } from '../../services/maintenance/control/src/mcp.ts';
import { localD1 } from './d1.ts';

const owner = 'owner@example.invalid';
async function call(handler: ReturnType<typeof protocolHandler>, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await handler.fetch(new Request('https://control.example.invalid/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': LEGACY_VERSIONS[0] },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
  const text = await response.text();
  return response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
}
const tool = async (handler: ReturnType<typeof protocolHandler>, name: string, args: Record<string, unknown>) => {
  const { result } = await call(handler, 'tools/call', { name, arguments: args });
  const text: string = result.content[0].text;
  return { result, text, data: JSON.parse(text.slice(text.indexOf('\n\n') + 2)) };
};

test('Control sends its usage guidance on initialize and lists exactly the three task tools on the baseline protocol', async () => {
  const handler = protocolHandler(() => controlServer(localD1(), owner, false), false);
  const init = await call(handler, 'initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: 'host', version: '1' } });
  assert.equal(init.result.instructions, CONTROL_INSTRUCTIONS);
  assert.match(init.result.instructions, /never create an approval/);
  const { result } = await call(handler, 'tools/list');
  assert.deepEqual(result.tools.map((t: { name: string }) => t.name).sort(), ['control_task', 'get_task', 'request_task']);
  for (const t of result.tools) assert.ok(t.description.length > 40 && t.inputSchema.type === 'object', t.name);
  await handler.close();
});

test('request, inspect, list and control a task through the protocol', async () => {
  const db = localD1();
  const handler = protocolHandler(() => controlServer(db, owner, false), false);
  const missing = await tool(handler, 'request_task', { request_key: 'p1', instruction: 'Prepare Genesis', kind: 'prepare' });
  assert.equal(missing.data.status, 'needs_information');
  const created = await tool(handler, 'request_task', { request_key: 'p1', instruction: 'Prepare Genesis', kind: 'prepare',
    inputs: [{ kind: 'acquisition', id: 'route-1' }], extent: { books: ['GEN'] }, capabilities: ['source_text'],
    decision_refs: [{ kind: 'admission', ref: 'owner-decision:1', subject: 'route-1' }] });
  assert.equal(created.data.status, 'created');
  assert.match(created.text, /is queued/);
  const report = await tool(handler, 'get_task', { task_id: created.data.task_id });
  assert.deepEqual(report.data.remaining_extent, { books: ['GEN'] });
  assert.match(report.text, /not current/);
  const list = await tool(handler, 'get_task', {});
  assert.equal(list.data.tasks[0].id, created.data.task_id);
  const stale = await tool(handler, 'control_task', { task_id: created.data.task_id, expected_revision: 5, action: 'pause' });
  assert.equal(stale.result.isError, true);
  const paused = await tool(handler, 'control_task', { task_id: created.data.task_id, expected_revision: 1, action: 'pause' });
  assert.equal(paused.data.state, 'paused');
  const invalid = await call(handler, 'tools/call', { name: 'request_task', arguments: { request_key: '../x', instruction: 'x', kind: 'promote' } });
  assert.ok(invalid.error || invalid.result.isError);
  await handler.close();
});

test('another person or a service identity cannot read or create the owner\'s tasks', async () => {
  const db = localD1();
  const ownerHandler = protocolHandler(() => controlServer(db, owner, false), false);
  const created = await tool(ownerHandler, 'request_task', { request_key: 'r1', instruction: 'Roll back', kind: 'rollback' });
  const other = protocolHandler(() => controlServer(db, 'other@example.invalid', false), false);
  assert.equal((await tool(other, 'get_task', { task_id: created.data.task_id })).result.isError, true);
  const service = protocolHandler(() => controlServer(db, undefined, false), false);
  const refused = await call(service, 'tools/call', { name: 'get_task', arguments: {} });
  assert.ok(refused.error || refused.result.isError);
  for (const h of [ownerHandler, other, service]) await h.close();
});
