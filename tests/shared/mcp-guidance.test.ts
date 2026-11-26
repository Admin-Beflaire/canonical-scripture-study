import test from 'node:test';
import assert from 'node:assert/strict';
import {controlServer} from '../../services/maintenance/control/src/mcp.ts';
import {ADMISSION_RULE} from '../../services/maintenance/control/src/guidance.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {
  ABSENCE_RULE,
  guidance,
  SUPERSCRIPTION_RULE,
} from '../../services/study/src/guidance.ts';
import {localD1} from '../maintenance/d1.ts';
import {buildPassageFixture} from '../study/passage-fixture.ts';
import {delivered, fieldDescriptions} from './mcp-call.ts';

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
    ADMISSION_RULE,
    'needs_information',
  ]);
  within(instructions, NEEDED, [
    ...tools.map(tool => tool.name),
    "the owner's instruction is the permission",
    'check back with get_task',
    'received, prepared, quality-checked, scope-checked, partial or current',
  ]);
});

test('Study: the translation rules come first, then the whole method', async () => {
  const {instructions, tools} = await delivered(study);
  within(instructions, OPENING, [
    'you translate, reason and explain',
    'call get_guidance with topic "translation"',
    'your own working translation from the original',
    'always write Yahweh for YHWH',
  ]);
  within(instructions, NEEDED, [guidance('method').text]);
  // A host that keeps less of the instructions still gets these with the study tool.
  const studyTool = tools.find(tool => tool.name === 'study')!;
  within(studyTool.description, NEEDED, [
    'call again with the same arguments plus the continuation',
    ABSENCE_RULE,
    SUPERSCRIPTION_RULE,
  ]);
});

test('Study: every rule on using the tool reaches the host on connect', async () => {
  const {instructions, tools} = await delivered(study);
  const connected = [
    instructions,
    ...tools.flatMap(tool => [
      tool.description,
      ...fieldDescriptions(tool.inputSchema),
    ]),
  ].join('\n');
  const rules = guidance('tools').text.split('\n').slice(1);
  assert.ok(rules.length > 0);
  for (const rule of rules)
    assert.ok(connected.includes(rule.slice(2)), rule.slice(0, 60));
});
