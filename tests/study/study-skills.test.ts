import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {skillFile} from '../../packages/shared/src/skills.ts';
import {MODES, study, type Mode} from '../../services/study/src/coordinator.ts';
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
import {buildFixture} from './fixture.ts';
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

/** What a successful call returns besides the gate: the same result as the study without it. */
async function ungated(request: Parameters<typeof study>[1]) {
  const result = await study(buildPassageFixture().env, request);
  return JSON.parse(JSON.stringify(result));
}

/** The verse labels of a result, with the role each has in it. */
const verses = (data: {evidence: {span: {label: string}; role: string}[]}) =>
  data.evidence.map(item => `${item.span.label} ${item.role}`);

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
    assert.deepEqual(served.data, await ungated(request));
    assert.equal(served.data.translation_rules, undefined);
    assert.equal(served.data.release_id, 'rel-p');
    if (mode === 'conclusion_check') {
      assert.equal(served.data.statement, null);
      assert.equal(served.data.limitations[0].scope, 'statement');
    } else if (mode === 'inspect_source')
      assert.deepEqual(verses(served.data), ['Gen 1:1 requested']);
    else {
      const [asked, next] = verses(served.data);
      assert.deepEqual([asked, next], ['Gen 1:1 requested', 'Gen 1:2 context']);
    }
    await handler.close();
  });

test('the code read from a skill file serves the whole study; a refused continuation can be repeated', async () => {
  const {handler} = server();
  const file = (await readSkills(handler)).find(
    skill => skill.name === 'translation',
  )!.file;
  const skill_code = CODE.exec(file)![1];
  const request = {mode: 'translation' as const, references: ['Gen 1']};
  let continuation: string | null = null;
  const delivered: string[] = [];
  let calls = 0;
  do {
    const args: Parameters<typeof study>[1] = {
      ...request,
      ...(continuation ? {continuation} : {}),
    };
    for (const wrong of [undefined, 'translation-0']) {
      const refused = await tool(handler, 'study', {
        ...args,
        skill_code: wrong,
      });
      assert.equal(refused.data.limitations[0].state, 'skill_required');
      assert.deepEqual(refused.data.evidence, []);
    }
    const {isError, data} = await tool(handler, 'study', {
      ...args,
      skill_code,
    });
    assert.equal(isError, false);
    assert.deepEqual(data, await ungated(args));
    assert.equal(data.translation_rules, undefined);
    delivered.push(...verses(data));
    continuation = data.continuation;
  } while (continuation && ++calls < 100);
  assert.equal(continuation, null, 'the study is exhausted');
  assert.ok(calls > 1, 'the study needs several continuations');
  // Genesis 1 has 31 verses; each arrives once, in reading order.
  assert.deepEqual(
    delivered,
    Array.from({length: 31}, (_, index) => `Gen 1:${index + 1} requested`),
  );
  await handler.close();
});

test('every skill, and the study tool, keep the step-by-step exception to following continuations', async () => {
  const exception = 'unless the user asked to go step by step (interactive)';
  const {tools} = await delivered(() =>
    studyServer(buildPassageFixture().env, false),
  );
  assert.ok(
    tools.find(tool => tool.name === 'study')!.description.includes(exception),
  );
  for (const skill of SKILLS) {
    assert.ok(skill.text.includes(exception), skill.name);
    for (const line of skill.text.split('\n'))
      if (/continuation[^.]*before answering/i.test(line))
        assert.ok(line.includes(exception), `${skill.name}: ${line}`);
  }
  assert.match(
    guidance('exegesis').text,
    /a study the user takes step by step, write a step when/,
  );
});

for (const [name, fixture, limited] of [
  [
    'without a statement',
    () => buildPassageFixture().env,
    [
      {
        state: 'missing_evidence',
        scope: 'statement',
        detail:
          'No approved character-of-God statement is selected. Ordinary sources remain usable.',
      },
    ],
  ],
  ['with a statement', () => buildFixture().env, []],
] as const)
  test(`the conclusion check ${name} returns facts and no guidance`, async () => {
    const handler = protocolHandler(() => studyServer(fixture(), false), false);
    const skill_code = await codeFor(handler, 'conclusion_check');
    const {data} = await tool(handler, 'study', {
      mode: 'conclusion_check',
      skill_code,
    });
    assert.deepEqual(Object.keys(data).sort(), [
      'continuation',
      'depth',
      'guidance_version',
      'language',
      'limitations',
      'mode',
      'release_id',
      'statement',
    ]);
    assert.deepEqual(data.limitations, limited);
    assert.equal(data.statement === null, limited.length === 1);
    assert.match(
      guidance('conclusion-check').text,
      /it is never a premise, agreement proves nothing/,
    );
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
    'returns the name, version, wording and scriptural basis (reader references)',
    'present only its own wording as the statement',
    'It is never a premise and agreement proves nothing',
    'call this your own check, not the approved version',
    'Show points only when the reader asks',
    'every sense possible here, which interpretation of part 7 each sense supports',
    'An entry that gives only the chosen sense is incomplete when another sense is possible here',
    'when only one sense is possible here, say why',
    'every interpretation of part 7, not only the strongest',
    'When there is another serious reading, a check of the favoured one alone is incomplete',
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
    '- Check every serious interpretation',
    'exegesis',
    'conclusion-check',
  );
  for (const name of ['exegesis', 'comparison'])
    for (const rule of TRANSLATION_RULES)
      assert.ok(guidance(name).text.includes(`- ${rule}`), name);
});
