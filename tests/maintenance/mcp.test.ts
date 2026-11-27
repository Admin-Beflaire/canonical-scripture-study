import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {controlServer} from '../../services/maintenance/control/src/mcp.ts';
import {
  ADMISSION_RULE,
  CONTROL_INSTRUCTIONS,
  DECISION_REF_MAX,
} from '../../services/maintenance/control/src/guidance.ts';
import {STEPS} from '../../services/maintenance/control/src/tasks.ts';
import {localD1} from './d1.ts';
import {call, callTool, delivered} from '../shared/mcp-call.ts';
import {prepareGenesis} from './requests.ts';

const owner = 'owner@example.invalid';
const control = () => controlServer(localD1(), owner, false);
test('the guidance names every step, constraint and decision a task can use, where it is used', async () => {
  const {tools} = await delivered(control);
  const request = tools.find(t => t.name === 'request_task')!;
  const fields = Object.fromEntries(
    Object.entries(request.inputSchema.properties!).map(([name, field]) => [
      name,
      field.description ?? '',
    ]),
  );
  for (const step of STEPS)
    for (const text of [CONTROL_INSTRUCTIONS, fields.steps])
      assert.match(text, new RegExp(`\\b${step}\\b`), step);
  for (const key of [
    'fetch_recipe',
    'recipe',
    'candidate',
    'replaces',
    'select_release',
  ])
    assert.match(fields.constraints, new RegExp(`\\b${key}:`), key);
  for (const kind of ['admission', 'exclusion', 'statement'])
    assert.match(fields.decision_refs, new RegExp(`\\b${kind}:`), kind);
  // An admission is the owner's decision about a source, quoted by a short reference the field accepts.
  assert.ok(fields.decision_refs.includes(ADMISSION_RULE));
  assert.ok(
    fields.decision_refs.includes(`at most ${DECISION_REF_MAX} characters`),
  );
  const all = [
    CONTROL_INSTRUCTIONS,
    ...tools.map(tool => tool.description),
    ...Object.values(fields),
  ].join('\n');
  // No removed step kind; one task chains fetch and build; a decision is referenced, not copied.
  for (const removed of [
    'incorporate_statement',
    'kind prepare',
    'prepare (includes',
    'separate tasks',
    'exact words',
  ])
    assert.ok(!all.includes(removed), removed);
});

test('Control sends its usage guidance on initialize and lists exactly the five tools on the baseline protocol', async () => {
  const {instructions, tools} = await delivered(control);
  assert.equal(instructions, CONTROL_INSTRUCTIONS);
  assert.match(instructions, /never create an approval/);
  assert.deepEqual(tools.map(t => t.name).sort(), [
    'control_task',
    'get_recipe',
    'get_task',
    'request_task',
    'tidy_releases',
  ]);
  for (const t of tools)
    assert.ok(
      t.description.length > 40 && t.inputSchema.type === 'object',
      t.name,
    );
});

test('request, inspect, list and control a task through the protocol', async () => {
  const db = localD1();
  const handler = protocolHandler(() => controlServer(db, owner, false), false);
  const missing = await callTool(handler, 'request_task', {
    request_key: 'p1',
    instruction: 'Prepare Genesis',
    steps: ['build'],
  });
  assert.equal(missing.data.status, 'needs_information');
  const created = await callTool(handler, 'request_task', {...prepareGenesis});
  assert.equal(created.data.status, 'created');
  assert.match(created.text, /is queued/);
  const report = await callTool(handler, 'get_task', {
    task_id: created.data.task_id,
  });
  assert.deepEqual(report.data.remaining_extent, {books: ['GEN']});
  assert.match(report.text, /not current/);
  const list = await callTool(handler, 'get_task', {});
  assert.equal(list.data.tasks[0].id, created.data.task_id);
  const stale = await callTool(handler, 'control_task', {
    task_id: created.data.task_id,
    expected_revision: 5,
    action: 'pause',
  });
  assert.equal(stale.result.isError, true);
  // Reading the task noted that no dispatch is configured, which advanced its revision.
  const read = await callTool(handler, 'get_task', {
    task_id: created.data.task_id,
  });
  const paused = await callTool(handler, 'control_task', {
    task_id: created.data.task_id,
    expected_revision: read.data.revision,
    action: 'pause',
  });
  assert.equal(paused.data.state, 'paused');
  const invalid = await call(handler, 'tools/call', {
    name: 'request_task',
    arguments: {request_key: '../x', instruction: 'x', steps: ['promote']},
  });
  assert.ok(invalid.error || invalid.result.isError);
  await handler.close();
});

test("another person or a service identity cannot read or create the owner's tasks", async () => {
  const db = localD1();
  const ownerHandler = protocolHandler(
    () => controlServer(db, owner, false),
    false,
  );
  const created = await callTool(ownerHandler, 'request_task', {
    request_key: 'r1',
    instruction: 'Roll back',
    steps: ['rollback'],
  });
  const other = protocolHandler(
    () => controlServer(db, 'other@example.invalid', false),
    false,
  );
  assert.equal(
    (await callTool(other, 'get_task', {task_id: created.data.task_id})).result
      .isError,
    true,
  );
  const service = protocolHandler(
    () => controlServer(db, undefined, false),
    false,
  );
  const refused = await call(service, 'tools/call', {
    name: 'get_task',
    arguments: {},
  });
  assert.ok(refused.error || refused.result.isError);
  for (const h of [ownerHandler, other, service]) await h.close();
});

test("tidy_releases cleans up on the owner's call, reports when more remains, and refuses others", async () => {
  const db = localD1();
  const objects = {
    async list() {
      return {objects: []};
    },
    async remove() {},
  };
  const handler = protocolHandler(
    () => controlServer(db, owner, false, null, objects),
    false,
  );
  const done = await callTool(handler, 'tidy_releases', {});
  assert.deepEqual(done.data, {
    memberships: 0,
    outputs: 0,
    skipped: 0,
    objects: 0,
    bytes: 0,
    objectsLeft: 0,
    more: false,
  });
  assert.match(
    done.text,
    /Removed the membership of 0 row\(s\) and 0 saved output\(s\) and asked the bucket to delete 0 stored object\(s\) \(0 B as recorded, not measured\)\./,
  );
  const service = protocolHandler(
    () => controlServer(db, undefined, false),
    false,
  );
  const refused = await call(service, 'tools/call', {
    name: 'tidy_releases',
    arguments: {},
  });
  assert.ok(refused.error || refused.result.isError);
  for (const h of [handler, service]) await h.close();
});
