import test from 'node:test';
import assert from 'node:assert/strict';
import {controlServer} from '../../services/maintenance/control/src/mcp.ts';
import * as rules from '../../services/maintenance/control/src/guidance.ts';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {localD1} from '../maintenance/d1.ts';
import {buildPassageFixture} from '../study/passage-fixture.ts';
import {delivered, fieldDescriptions} from './mcp-call.ts';
import {readSkills} from './mcp-skills.ts';
const NEEDED = 2048;
const MOST = 4096;

const control = () => controlServer(localD1(), 'owner@example.invalid', false);
const study = () => studyServer(buildPassageFixture().env, false);

const within = (text: string, limit: number, rules: string[]) => {
  for (const rule of rules)
    assert.ok(text.slice(0, limit).includes(rule), `${limit}: ${rule}`);
};

for (const [name, server] of Object.entries({Control: control, Study: study}))
  test(`${name}: no text a host receives on connect is longer than hosts keep`, async () => {
    const {instructions, tools} = await delivered(server);
    assert.ok(instructions.length <= MOST, `${instructions.length} characters`);
    for (const tool of tools)
      for (const text of [
        tool.description,
        ...fieldDescriptions(tool.inputSchema),
      ])
        assert.ok(
          text.length <= NEEDED,
          `${tool.name}: ${text.length} characters`,
        );
  });

async function controlSkills() {
  const handler = protocolHandler(control, false);
  const skills = await readSkills(handler);
  await handler.close();
  return skills;
}

test('Control: exactly four skills with digests, named within what hosts keep', async () => {
  const names = (await controlSkills()).map(skill => skill.name);
  assert.deepEqual(names.sort(), [
    'add-source',
    'follow-tasks',
    'remove-source',
    'restore-data',
  ]);
  const {instructions} = await delivered(control);
  within(instructions, NEEDED, names);
});

test('Control: tool descriptions carry their skill guidance and scope of authority', async () => {
  const {tools} = await delivered(control);
  const skillsByTool = {
    request_task: [
      'add-source',
      'remove-source',
      'restore-data',
      'follow-tasks',
    ],
    get_task: ['follow-tasks', 'add-source'],
    get_recipe: ['add-source', 'remove-source'],
    control_task: ['follow-tasks'],
    tidy_releases: ['follow-tasks'],
  };
  for (const [name, skills] of Object.entries(skillsByTool)) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, name);
    if (['request_task', 'control_task', 'tidy_releases'].includes(name))
      assert.ok(tool.description.startsWith(rules.OWNER_INSTRUCTION), name);
    within(tool.description, 512, [
      'resources/read',
      'skill://<name>/SKILL.md',
      ...skills,
    ]);
  }
});

test('Control: each kind of request has its way in exactly one skill', async () => {
  const skills = await controlSkills();
  const {tools} = await delivered(control);
  const recipe = tools.find(tool => tool.name === 'get_recipe')!;
  const task = tools.find(tool => tool.name === 'get_task')!;
  assert.ok(
    fieldDescriptions(recipe.inputSchema).some(
      text =>
        text.includes(rules.ANALYSE_SOURCE) &&
        text.includes(rules.ANALYSIS_JUDGEMENT),
    ),
  );
  assert.ok(task.description.includes(rules.ANALYSIS_REPORT));
  const ways: [rule: string, skill: string][] = [
    [rules.ANALYSE_SOURCE, 'add-source'],
    [rules.ANALYSIS_REPORT, 'add-source'],
    [rules.ANALYSIS_JUDGEMENT, 'add-source'],
    [rules.BELONGING, 'add-source'],
    [rules.STATEMENT_NEEDS, 'add-source'],
    [rules.PREPARE, 'add-source'],
    [rules.CANDIDATE, 'add-source'],
    [rules.REPLACE_ORDER, 'add-source'],
    [rules.REPLACE_PART, 'add-source'],
    [rules.REMOVE, 'remove-source'],
    [rules.EXCLUDE, 'remove-source'],
    [rules.ROLLBACK, 'restore-data'],
    [rules.VALIDATE, 'restore-data'],
    [rules.CONTROL_RULE, 'follow-tasks'],
    [rules.SUPERSEDE, 'follow-tasks'],
    [rules.TIDY, 'follow-tasks'],
  ];
  for (const [rule, name] of ways)
    assert.deepEqual(
      skills.filter(item => item.file.includes(rule)).map(item => item.name),
      [name],
      rule,
    );
});

test('Study advertises exact WEB spellings where search leads are entered', async () => {
  const {tools} = await delivered(study);
  const tool = tools.find(tool => tool.name === 'study')!;
  assert.ok(
    fieldDescriptions(tool.inputSchema).some(text =>
      [
        'use lookup "word"',
        'apostrophes and hyphens',
        'Psalm titles',
        'curly apostrophe (’)',
        'apostrophes inside a word',
        '"Jesus’"',
        '"love"',
        '"Love"',
      ].every(rule => text.includes(rule)),
    ),
  );
});
