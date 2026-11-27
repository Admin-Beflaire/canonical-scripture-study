import test from 'node:test';
import assert from 'node:assert/strict';
import {controlServer} from '../../services/maintenance/control/src/mcp.ts';
import * as rules from '../../services/maintenance/control/src/guidance.ts';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {
  ABSENCE_RULE,
  CONTINUATION,
  COVERAGE,
  LANGUAGE_AIDS,
  NOT_OFFERED,
  NUMBERING,
  PASSAGES,
  PROPER_NAMES,
  SELECTED_DATA,
  SKILLS,
  SUPERSCRIPTION_RULE,
  WORD_FOCUS,
  WORD_LOOKUPS,
} from '../../services/study/src/guidance.ts';
import {localD1} from '../maintenance/d1.ts';
import {buildPassageFixture} from '../study/passage-fixture.ts';
import {delivered, fieldDescriptions} from './mcp-call.ts';
import {readSkills} from './mcp-skills.ts';

/** Lengths at which AI hosts are measured or reported to cut long text; what lies beyond
 *  a host's limit never reaches the AI. */
const OPENING = 512;
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

test('Control: the rules come first, then everything else that is needed', async () => {
  const {instructions, tools} = await delivered(control);
  within(instructions, OPENING, [
    "only on the owner's explicit instruction",
    'start with get_recipe',
    'never create an approval',
    rules.ADMISSION_RULE,
    'If a result is "needs_information", ask exactly the listed questions.',
  ]);
  within(instructions, NEEDED, [
    ...tools.map(tool => tool.name),
    "the owner's instruction is the permission",
    'check back with get_task',
    'received, prepared, quality-checked, scope-checked, partial or current',
  ]);
});

test('Control: only fetch and build start from a recipe, and exclusion stays an owner decision', async () => {
  const {tools} = await delivered(control);
  const request = tools.find(tool => tool.name === 'request_task')!;
  within(request.description, NEEDED, [
    'For a fetch or build, ask get_recipe first',
    'select, remove, rollback and validate_restore on their own have no recipe',
  ]);
  const fields = fieldDescriptions(request.inputSchema).join('\n');
  for (const rule of [
    'For fetch and build, the exact input IDs get_recipe returns',
    'A select, rollback or validate_restore task needs none.',
    'when the owner decided to exclude them, add one exclusion decision_ref per source revision',
    'only for an exclusion the owner decided, one per source revision as subject',
  ])
    assert.ok(fields.includes(rule), rule);
});

/** What a host without skills receives on connect. */
async function connected() {
  const {instructions, tools} = await delivered(control);
  return [
    instructions,
    ...tools.flatMap(tool => [
      tool.description,
      ...fieldDescriptions(tool.inputSchema),
    ]),
  ].join('\n');
}

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

test('Control: every rule in a skill also reaches a host without skills', async () => {
  const received = await connected();
  for (const {name, file} of await controlSkills()) {
    const body = file.slice(file.indexOf('\n---\n') + 5).split('\n');
    const lines = body.filter(line => line && !line.endsWith(':'));
    assert.ok(lines.length, name);
    for (const line of lines) {
      assert.ok(line.startsWith('- '), `${name}: not a rule: ${line}`);
      assert.ok(received.includes(line.slice(2)), `${name}: ${line}`);
    }
  }
});

test('Control: each kind of request has its way in exactly one skill', async () => {
  const skills = await controlSkills();
  const ways: [rule: string, skill: string][] = [
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

test('Study: connecting leads to the skills first, and the study tool says so', async () => {
  const {instructions, tools} = await delivered(study);
  within(instructions, OPENING, [
    'you translate, reason and explain',
    'Every question goes through a skill',
    'call get_guidance with its name as topic',
    'the skill_code that every study call requires',
  ]);
  within(
    instructions,
    NEEDED,
    SKILLS.map(skill => `- ${skill.name}: ${skill.modes.join(', ')}`),
  );
  // A host that keeps less of the instructions still gets these with the study tool.
  const studyTool = tools.find(tool => tool.name === 'study')!;
  within(studyTool.description, OPENING, ['Every study goes through a skill']);
  within(studyTool.description, NEEDED, [
    CONTINUATION,
    COVERAGE,
    ABSENCE_RULE,
    NUMBERING,
    SUPERSCRIPTION_RULE,
  ]);
});

test('Study: every rule on using the tool arrives with the tools', async () => {
  const {tools} = await delivered(study);
  const connected = tools
    .flatMap(tool => [tool.description, ...fieldDescriptions(tool.inputSchema)])
    .join('\n');
  for (const rule of [
    CONTINUATION,
    COVERAGE,
    NUMBERING,
    PASSAGES,
    WORD_LOOKUPS,
    WORD_FOCUS,
    PROPER_NAMES,
    LANGUAGE_AIDS,
    NOT_OFFERED,
    SELECTED_DATA,
  ])
    assert.ok(connected.includes(rule), rule.slice(0, 60));
});
