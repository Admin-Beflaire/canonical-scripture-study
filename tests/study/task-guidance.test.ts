import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {skillFile} from '../../packages/shared/src/skills.ts';
import {MODES} from '../../services/study/src/coordinator.ts';
import {
  guidance,
  TASKS,
  taskGuidance,
} from '../../services/study/src/guidance.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {call} from '../shared/mcp-call.ts';
import {
  readSkills,
  SKILLS_EXTENSION,
  skillSupport,
} from '../shared/mcp-skills.ts';
import {buildPassageFixture} from './passage-fixture.ts';

const NAMES = ['comparison', 'exegesis', 'theme', 'translation', 'word-study'];

for (const enhancements of [false, true])
  test(`Study lists exactly its task skills, each the text of its topic, newer features ${enhancements ? 'on' : 'off'}`, async () => {
    const {env} = buildPassageFixture();
    const handler = protocolHandler(
      () => studyServer(env, enhancements),
      enhancements,
    );
    const skills = await readSkills(handler);
    assert.deepEqual(
      skills.map(skill => skill.name),
      NAMES,
    );
    for (const skill of skills) {
      const task = TASKS.find(task => task.name === skill.name)!;
      const {result} = await call(handler, 'tools/call', {
        name: 'get_guidance',
        arguments: {topic: skill.name},
      });
      const topic = JSON.parse(result.content[0].text);
      assert.equal(topic.text, task.text);
      assert.equal(skill.file, skillFile({...task, text: topic.text}));
      assert.equal(skill.description, task.description);
    }
    await handler.close();
  });

test('with newer protocol features on, the Study session declares skill support', async () => {
  const {env} = buildPassageFixture();
  const handler = protocolHandler(() => studyServer(env, true), true);
  const session = await skillSupport(handler, '2026-07-28');
  assert.ok(session.capabilities.extensions?.[SKILLS_EXTENSION]);
  assert.ok(session.capabilities.tools);
  await handler.close();
});

test('each study mode has one task text, and its key rules are part of that text', () => {
  for (const mode of MODES) {
    const tasks = TASKS.filter(task => task.modes.includes(mode));
    const none = mode === 'inspect_source' || mode === 'conclusion_check';
    assert.equal(tasks.length, none ? 0 : 1, mode);
    const attached = taskGuidance(mode);
    // Translating carries its own key rules instead.
    assert.equal(attached === null, none || mode === 'translation', mode);
    if (!attached) continue;
    assert.equal(attached.topic, tasks[0].name);
    assert.ok(guidance(attached.topic).text.includes(attached.text), mode);
    assert.match(attached.note, new RegExp(`"${attached.topic}"`));
  }
});

test('the exegesis text keeps the agreed order, points and statement check', () => {
  const text = guidance('exegesis').text;
  const order = [
    'Core summary',
    'Words and meaning',
    'Historical and cultural background',
    'Literary context',
    'Storyline through Scripture',
    'Quotations, echoes and themes',
    'Interpretations:',
    'Christ as anchor',
    "Check of the conclusions against God's revealed character",
  ].map((part, index) => text.indexOf(`${index + 1}. ${part}`));
  assert.ok(
    order.every(at => at >= 0),
    String(order),
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.deepEqual(
    [...text.matchAll(/^ {2}([+-]\d) /gm)].map(found => found[1]),
    ['+2', '+2', '+1', '+1', '+1', '-1', '-1', '-2'],
  );
  for (const rule of [
    'never counts as support',
    'not named strongest, whatever its total',
    "God's character gives no points: it is a check, never a premise",
    'mode "conclusion_check"',
    "It does not return the statement's wording yet",
    'never present other words as the statement',
    'call this your own check, not the approved version',
    'Show points only when the reader asks',
  ])
    assert.ok(text.includes(rule), rule);
});

test('translating and comparing weigh witnesses by one text; word study shares the translation key', () => {
  const translation = guidance('translation').text;
  const shared = (from: string, to: string, other: string) => {
    const start = translation.indexOf(from);
    const block = translation.slice(
      start,
      translation.indexOf('\n', translation.indexOf(to, start)),
    );
    assert.ok(start >= 0 && block.length > 500);
    assert.ok(guidance(other).text.includes(block), other);
  };
  shared(
    '- Witnesses are weighed, not counted',
    '- New Testament quotations decide',
    'comparison',
  );
  shared('- YHWH is always', "- A word's lexical range", 'word-study');
});
