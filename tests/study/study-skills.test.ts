import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {skillFile} from '../../packages/shared/src/skills.ts';
import {MODES, type Mode} from '../../services/study/src/coordinator.ts';
import {
  guidance,
  SKILLS,
  STUDY_INSTRUCTIONS,
  TRANSLATION_RULES,
} from '../../services/study/src/guidance.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {call, delivered} from '../shared/mcp-call.ts';
import {
  readSkills,
  SKILLS_EXTENSION,
  skillSupport,
} from '../shared/mcp-skills.ts';
import {buildPassageFixture, HEB} from './passage-fixture.ts';

const NAMES = [
  'comparison',
  'conclusion-check',
  'exegesis',
  'source-inspection',
  'theme',
  'translation',
  'word-study',
];
const CODE = /Skill code: (\S+)\n/;

type Handler = ReturnType<typeof protocolHandler>;

function server(enhancements = false) {
  const fixture = buildPassageFixture();
  const handler = protocolHandler(
    () => studyServer(fixture.env, enhancements),
    enhancements,
  );
  return {...fixture, handler};
}

async function tool(handler: Handler, name: string, args: object) {
  const {result} = await call(handler, 'tools/call', {name, arguments: args});
  return {
    isError: result.isError === true,
    data: JSON.parse(result.content[0].text),
  };
}

/** The code as a host without skill support reads it: from the end of the topic. */
async function codeFor(handler: Handler, mode: Mode) {
  const {name} = SKILLS.find(skill => skill.modes.includes(mode))!;
  const {data} = await tool(handler, 'get_guidance', {topic: name});
  return CODE.exec(data.text)![1];
}

/** A request that returns something in this mode. */
function requestFor(mode: Mode, source: string) {
  if (mode === 'conclusion_check') return {mode};
  return {
    mode,
    references: ['Gen 1:1'],
    ...(mode === 'inspect_source' ? {sources: [source]} : {}),
  };
}

for (const enhancements of [false, true])
  test(`Study lists exactly its skills, each the text of its topic, newer features ${enhancements ? 'on' : 'off'}`, async () => {
    const {handler} = server(enhancements);
    const skills = await readSkills(
      handler,
      enhancements ? '2026-07-28' : '2025-11-25',
    );
    assert.deepEqual(
      skills.map(skill => skill.name),
      NAMES,
    );
    for (const read of skills) {
      const skill = SKILLS.find(skill => skill.name === read.name)!;
      const {data} = await tool(handler, 'get_guidance', {topic: read.name});
      assert.equal(data.text, skill.text);
      assert.equal(read.file, skillFile({...skill, text: data.text}));
      assert.equal(read.description, skill.description);
    }
    await handler.close();
  });

test('with newer protocol features on, the Study session declares skill support', async () => {
  const {handler} = server(true);
  const session = await skillSupport(handler, '2026-07-28');
  assert.ok(session.capabilities.extensions?.[SKILLS_EXTENSION]);
  assert.ok(session.capabilities.tools);
  await handler.close();
});

test('every study mode has one skill, which names the mode, holds the method and ends with its code', () => {
  for (const mode of MODES) {
    const skills = SKILLS.filter(skill => skill.modes.includes(mode));
    assert.equal(skills.length, 1, mode);
    const [skill] = skills;
    assert.ok(skill.text.startsWith('How to work:'), mode);
    assert.ok(skill.text.includes(`"${mode}"`), mode);
    assert.ok(skill.text.includes('Method:\n- Read the wording'), mode);
    assert.equal(CODE.exec(skill.text)![1], skill.code);
    assert.ok(skill.code.startsWith(`${skill.name}-`));
    assert.ok(skill.description.includes(mode), skill.description);
  }
  assert.equal(new Set(SKILLS.map(skill => skill.code)).size, SKILLS.length);
});

test("a skill's code is found in that skill only", async () => {
  const {tools} = await delivered(() =>
    studyServer(buildPassageFixture().env, false),
  );
  const elsewhere = [
    STUDY_INSTRUCTIONS,
    JSON.stringify(tools),
    guidance('all').text,
    guidance('unknown').text,
  ];
  for (const skill of SKILLS) {
    const others = SKILLS.filter(other => other !== skill);
    for (const text of [
      ...elsewhere,
      skill.description,
      ...others.map(other => other.text),
    ])
      assert.ok(!text.includes(skill.code), skill.name);
  }
});

for (const mode of MODES)
  test(`${mode}: evidence only with the code of its skill`, async () => {
    const {handler, db} = server();
    const request = requestFor(mode, HEB);
    const needed = SKILLS.find(skill => skill.modes.includes(mode))!;
    const other = SKILLS.find(skill => skill !== needed)!;
    const prepare = db.prepare.bind(db);
    let reads = 0;
    db.prepare = sql => {
      reads++;
      return prepare(sql);
    };
    for (const skill_code of [undefined, other.code, `${needed.name}-0`]) {
      const refused = await tool(handler, 'study', {...request, skill_code});
      assert.equal(refused.isError, true);
      assert.deepEqual(refused.data.evidence, []);
      assert.equal(refused.data.continuation, null);
      const [why] = refused.data.limitations;
      assert.equal(why.state, 'skill_required');
      assert.ok(why.detail.includes(`Read the "${needed.name}" skill`));
      assert.ok(!why.detail.includes(needed.code));
    }
    assert.equal(reads, 0, 'a refused call reads nothing');
    const skill_code = await codeFor(handler, mode);
    const served = await tool(handler, 'study', {...request, skill_code});
    assert.equal(served.isError, false, JSON.stringify(served.data));
    assert.ok(reads > 0);
    assert.equal(served.data.translation_rules, undefined);
    await handler.close();
  });

test('the code read from a skill file serves the study, and every continuation needs it', async () => {
  const {handler} = server();
  const file = (await readSkills(handler)).find(
    skill => skill.name === 'translation',
  )!.file;
  const skill_code = CODE.exec(file)![1];
  const request = {mode: 'translation', references: ['Gen 1']};
  let continuation: string | null = null;
  const units: string[] = [];
  let batches = 0;
  do {
    const args = {...request, ...(continuation ? {continuation} : {})};
    if (continuation) {
      const refused = await tool(handler, 'study', args);
      assert.equal(refused.data.limitations[0].state, 'skill_required');
    }
    const {data} = await tool(handler, 'study', {...args, skill_code});
    assert.equal(data.translation_rules, undefined);
    for (const item of data.evidence) units.push(item.span.segments[0].unit_id);
    continuation = data.continuation;
  } while (continuation && ++batches < 20);
  assert.ok(batches > 0);
  assert.ok(units.includes('Gen.1.1') && units.includes('Gen.1.31'));
  await handler.close();
});

test('the exegesis skill keeps the agreed order, points and statement check', () => {
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
    'read the conclusion-check skill',
    'mode "conclusion_check"',
    "It does not return the statement's wording yet",
    'never present other words as the statement',
    'call this your own check, not the approved version',
    'Show points only when the reader asks',
  ])
    assert.ok(text.includes(rule), rule);
});

test('skills share one text for a rule two of them need', () => {
  const shared = (from: string, to: string, a: string, b: string) => {
    const text = guidance(a).text;
    const start = text.indexOf(from);
    const block = text.slice(
      start,
      text.indexOf('\n', text.indexOf(to, start)),
    );
    assert.ok(start >= 0 && block.length > 500, from);
    assert.ok(guidance(b).text.includes(block), b);
  };
  shared(
    '- Witnesses are weighed, not counted',
    '- New Testament quotations decide',
    'translation',
    'comparison',
  );
  shared(
    '- YHWH is always',
    "- A word's lexical range",
    'translation',
    'word-study',
  );
  shared(
    '- Results with evidence do not carry the statement',
    '- Without one',
    'exegesis',
    'conclusion-check',
  );
  for (const name of ['exegesis', 'comparison'])
    for (const rule of TRANSLATION_RULES)
      assert.ok(guidance(name).text.includes(`- ${rule}`), name);
});
