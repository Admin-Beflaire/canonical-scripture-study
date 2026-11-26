import test from 'node:test';
import assert from 'node:assert/strict';
import {
  protocolHandler,
  LEGACY_VERSIONS,
} from '../../packages/shared/src/platform.ts';
import {
  controlServer,
  CONTROL_INSTRUCTIONS,
} from '../../services/maintenance/control/src/mcp.ts';
import {STEPS} from '../../services/maintenance/control/src/tasks.ts';
import {readFileSync, readdirSync} from 'node:fs';
import {GitHubActions} from '../../services/maintenance/control/src/github.ts';
import {fakeGitHub} from './github.ts';
import {localD1} from './d1.ts';
import {prepareGenesis} from './requests.ts';

const owner = 'owner@example.invalid';
test('the instructions name every step and constraint a task can use, and no removed kind', () => {
  for (const step of STEPS)
    assert.match(CONTROL_INSTRUCTIONS, new RegExp(`\\b${step}\\b`), step);
  for (const key of [
    'fetch_recipe',
    'recipe',
    'candidate',
    'replaces',
    'select_release',
  ])
    assert.ok(
      CONTROL_INSTRUCTIONS.includes(`constraints.${key}`) ||
        CONTROL_INSTRUCTIONS.includes(`{${key}`) ||
        (CONTROL_INSTRUCTIONS.includes(`{candidate`) && key === 'candidate'),
      key,
    );
  for (const removed of [
    'incorporate_statement',
    'kind prepare',
    'prepare (includes',
  ])
    assert.ok(!CONTROL_INSTRUCTIONS.includes(removed), removed);
  assert.match(CONTROL_INSTRUCTIONS, /Starting a task/);
  assert.match(CONTROL_INSTRUCTIONS, /get_recipe/);
});

async function call(
  handler: ReturnType<typeof protocolHandler>,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
) {
  const response = await handler.fetch(
    new Request('https://control.example.invalid/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': LEGACY_VERSIONS[0],
      },
      body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
    }),
  );
  const text = await response.text();
  return response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(
        text
          .split('\n')
          .find(line => line.startsWith('data: '))!
          .slice(6),
      )
    : JSON.parse(text);
}
const tool = async (
  handler: ReturnType<typeof protocolHandler>,
  name: string,
  args: Record<string, unknown>,
) => {
  const {result} = await call(handler, 'tools/call', {name, arguments: args});
  const text: string = result.content[0].text;
  return {result, text, data: JSON.parse(text.slice(text.indexOf('\n\n') + 2))};
};

test('Control sends its usage guidance on initialize and lists exactly the five tools on the baseline protocol', async () => {
  const handler = protocolHandler(
    () => controlServer(localD1(), owner, false),
    false,
  );
  const init = await call(handler, 'initialize', {
    protocolVersion: LEGACY_VERSIONS[0],
    capabilities: {},
    clientInfo: {name: 'host', version: '1'},
  });
  assert.equal(init.result.instructions, CONTROL_INSTRUCTIONS);
  assert.match(init.result.instructions, /never create an approval/);
  const {result} = await call(handler, 'tools/list');
  assert.deepEqual(result.tools.map((t: {name: string}) => t.name).sort(), [
    'control_task',
    'get_recipe',
    'get_task',
    'request_task',
    'tidy_releases',
  ]);
  for (const t of result.tools)
    assert.ok(
      t.description.length > 40 && t.inputSchema.type === 'object',
      t.name,
    );
  await handler.close();
});

test('request, inspect, list and control a task through the protocol', async () => {
  const db = localD1();
  const handler = protocolHandler(() => controlServer(db, owner, false), false);
  const missing = await tool(handler, 'request_task', {
    request_key: 'p1',
    instruction: 'Prepare Genesis',
    steps: ['build'],
  });
  assert.equal(missing.data.status, 'needs_information');
  const created = await tool(handler, 'request_task', {...prepareGenesis});
  assert.equal(created.data.status, 'created');
  assert.match(created.text, /is queued/);
  const report = await tool(handler, 'get_task', {
    task_id: created.data.task_id,
  });
  assert.deepEqual(report.data.remaining_extent, {books: ['GEN']});
  assert.match(report.text, /not current/);
  const list = await tool(handler, 'get_task', {});
  assert.equal(list.data.tasks[0].id, created.data.task_id);
  const stale = await tool(handler, 'control_task', {
    task_id: created.data.task_id,
    expected_revision: 5,
    action: 'pause',
  });
  assert.equal(stale.result.isError, true);
  // Reading the task noted that no dispatch is configured, which advanced its revision.
  const read = await tool(handler, 'get_task', {task_id: created.data.task_id});
  const paused = await tool(handler, 'control_task', {
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
  const created = await tool(ownerHandler, 'request_task', {
    request_key: 'r1',
    instruction: 'Roll back',
    steps: ['rollback'],
  });
  const other = protocolHandler(
    () => controlServer(db, 'other@example.invalid', false),
    false,
  );
  assert.equal(
    (await tool(other, 'get_task', {task_id: created.data.task_id})).result
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
  const done = await tool(handler, 'tidy_releases', {});
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

/** Real recipes from the repository, as Control reads them from main. */
function realRecipes(...names: string[]) {
  const dir = new URL('../../collection/recipes/', import.meta.url);
  return Object.fromEntries(
    names.map(name => [
      `collection/recipes/${name}.json`,
      JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')),
    ]),
  );
}

function recipeHandler(db = localD1(), recipes = {}, down = false) {
  const gh = fakeGitHub({recipes});
  gh.state.down = down;
  const github = new GitHubActions(
    {repository: 'owner/app', token: 'synthetic-token'},
    gh.fetcher,
  );
  return protocolHandler(() => controlServer(db, owner, false, github), false);
}

/** Send a get_recipe answer as it stands: only a key, the instruction and the owner's admission are added. */
function sendAnswered(
  handler: ReturnType<typeof protocolHandler>,
  name: string,
  request: {inputs: {id: string}[]},
) {
  return tool(handler, 'request_task', {
    ...request,
    request_key: `k-${name}`.slice(0, 100),
    instruction: 'Do it',
    decision_refs: request.inputs.map(input => ({
      kind: 'admission',
      ref: 'owner-decision:1',
      subject: input.id,
    })),
  });
}

test('get_recipe lists recipes by word and answers with a request that request_task accepts', async () => {
  const names = [
    'stepbible-fetch-tahot-job-sng',
    'stepbible-tahot-sng',
    'stepbible-tahot-sng-reader',
    'stepdata-tbesg-5de0a47f',
  ];
  const handler = recipeHandler(localD1(), realRecipes(...names));
  const listed = await tool(handler, 'get_recipe', {find: 'SNG'});
  assert.deepEqual(listed.data.recipes, names.slice(0, 3).sort());
  for (const [name, does, steps] of [
    ['stepbible-fetch-tahot-job-sng', 'fetch', ['fetch']],
    ['stepbible-tahot-sng', 'build', ['build']],
    ['stepdata-tbesg-5de0a47f', 'fetch', ['fetch']],
  ] as const) {
    const answer = await tool(handler, 'get_recipe', {recipe: name});
    assert.equal(answer.data.does, does);
    assert.deepEqual(answer.data.request.steps, steps);
    assert.equal(answer.data.request.inputs.length, 2, name);
    // The answer is a request as it stands: only the owner's words and a key are added.
    const sent = await sendAnswered(handler, name, answer.data.request);
    assert.equal(sent.data.status, 'created', sent.text);
    assert.deepEqual(sent.data.limitations ?? [], [], name);
  }
  await handler.close();
});

test('get_recipe says what is missing first and refuses what is not a recipe on main', async () => {
  const handler = recipeHandler(localD1(), realRecipes('stepbible-tahot-sng'));
  const build = await tool(handler, 'get_recipe', {
    recipe: 'stepbible-tahot-sng',
  });
  assert.ok(
    build.data.notes.some((note: string) => note.includes('not saved yet')),
    JSON.stringify(build.data.notes),
  );
  const missing = await tool(handler, 'get_recipe', {recipe: 'nothing-here'});
  assert.equal(missing.result.isError, true);
  assert.match(missing.text, /not on main/);
  await handler.close();
});

test('every committed recipe answers with a request that Control does not block', async () => {
  const dir = new URL('../../collection/recipes/', import.meta.url);
  const names = readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -5));
  const db = localD1();
  const handler = recipeHandler(db, realRecipes(...names));
  const problems: string[] = [];
  for (const name of names) {
    const answer = await tool(handler, 'get_recipe', {recipe: name});
    if (!answer.data.found) {
      problems.push(`${name}: ${answer.data.message}`);
      continue;
    }
    const sent = await sendAnswered(handler, name, answer.data.request);
    const blocked =
      sent.data.state === 'blocked' || sent.data.limitations?.length;
    if (sent.data.status !== 'created' || blocked)
      problems.push(
        `${name}: ${sent.text} ${JSON.stringify(sent.data.limitations)}`,
      );
  }
  assert.deepEqual(problems, []);
  await handler.close();
});

test('get_recipe reports an unreachable GitHub plainly instead of failing', async () => {
  const handler = recipeHandler(localD1(), {}, true);
  for (const args of [{}, {recipe: 'stepbible-tahot-sng'}]) {
    const answer = await tool(handler, 'get_recipe', args);
    assert.equal(answer.result.isError, true);
    assert.match(answer.text, /GitHub did not answer/);
  }
  await handler.close();
});
