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
    'Working translation',
    'Background',
    'The text itself',
    'Your interpretation',
    'Comparison with the known interpretations',
    'Closing',
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
    // The text first, then the own reading, then the others.
    'name every place where the passage seems to contradict itself or other Scripture',
    'come at the verse where they matter, not in blocks of their own',
    // The background the explanation rests on.
    'the kind of writing (genre)',
    'who writes to whom and why, in which historical and cultural situation',
    'what the book as a whole argues or tells; where this passage stands in it',
    // The canon: what it builds on before, where it leads after.
    'its place in Scripture: the earlier texts, events and themes the passage builds on, and related writings of the same author or kind',
    'drawn from the text and this background',
    'where the line through Scripture leads from this passage, to Christ, without rewriting what the text meant',
    'When the asked verses depend on a larger unit, give its argument here',
    'gets all six parts',
    'form your own interpretation before you turn to known ones',
    'Coming first gives it no advantage',
    'its footnote gives the source word, every sense possible here, your choice and why',
    'part 3 says what each of those senses does to the reading',
    'gives only the chosen sense is incomplete when another sense is possible here',
    'when only one sense is possible here, say why',
    // Plain language and no talk about the work.
    'Write in everyday language and short sentences',
    'Write about the text, not about your work',
    // The translation keeps its footnotes; the exegesis comes on top.
    'Working translation with its footnotes',
    'built on top of the translation: parts 2 to 6 do not repeat its footnotes',
    'always with footnotes (standard level, or full when the reader asks for more depth)',
    'the argument of a larger unit is not written before it, because part 2 gives it',
    'the Sources and Limits lines stand once, at the end of the whole answer',
    'does not explain or interpret the passage',
    'the Sources and Limits lines once, at the end of the whole answer',
    // Points.
    'A theological premise that only an outside philosophical or religious concept, a later system or circular reasoning supplies never counts as support',
    'not named strongest, whatever its total',
    "God's character gives no points and is never a premise",
    'Show points only when the reader asks',
    // God's character: part of the work, shown only on request.
    'read the conclusion-check skill',
    'mode "conclusion_check"',
    'returns the name, version, wording and scriptural basis (reader references)',
    'present only its own wording as the statement',
    'It is never a premise and agreement proves nothing: what a reading says must come from the text',
    'call this your own check, not the approved version',
    "Test every known interpretation that matters against God's character, not only the ones close to yours",
    'do not write about the check, the statement or an outcome for each reading',
    'When no statement is selected, the Limits line says so',
    'tests a reading; a reading never redefines that character',
    'Good, just and loving keep their meaning when used of God',
    'can stand only by bending them is wrong',
    'Do not argue that an act must be good simply because a reading attributes it to God',
    'How sure you are counts',
    'when that stays uncertain, do not reject it, but lower how sure you are of it and say why',
    '-2 for each fault in its grounds: a fallacy (circular reasoning among them), a mistranslation, or passing over texts that say otherwise',
    'count such a text here, not also as an unexplained difficulty',
    'examine both the reading and the statement against Scripture again',
    'reject it as unacceptable, whatever else speaks for it, your own included',
    'Name a rejected reading in part 5, after the others, as not acceptable',
    'such as a place named in part 3',
    'leave the question open',
    'give that reason there, as a plain statement about the text and God',
    'Show the check only when the reader asks; then name the statement with its version',
  ])
    assert.ok(text.includes(rule), rule);
});

test("the exegesis works out its own interpretation in the light of God's character", () => {
  const text = guidance('exegesis').text;
  for (const rule of [
    'Before you form your own interpretation, read the conclusion-check skill',
    "in the light of God's character from start to end: working it out and testing it go together",
    'Before you deliver, test every theological conclusion that the finished answer draws or leaves possible against every part of the statement',
    'in your interpretation, the explanation of the text, the background, the comparison and the closing, with everything the weighing changed',
    'Rework from the text what clearly does not fit and test it again',
    'test again every conclusion that a later step changes',
    'An explanation that clearly clashes with any part of it is not an option',
    'still comes from the text and accounts for everything the text says',
    'say what remains uncertain, and bend neither of them',
    'with yours as one of them',
    'also how it deals with those places and exactly where it differs from yours',
    'as one of its own beside the known ones, also when it is close to one of them',
    'not an interpretation to rank',
  ])
    assert.ok(text.includes(rule), rule);
  // One order of work: text, statement, research, own reading, others, test.
  const steps = [
    'Start with the text',
    "Read the statement of God's character",
    'In its light, investigate the words, background and canon',
    'form your own interpretation before you turn to known ones',
    'Investigate the known interpretations',
    'test it as a whole before you deliver it',
  ].map(step => text.indexOf(step));
  assert.ok(
    steps.every((at, index) => at > (steps[index - 1] ?? 0)),
    String(steps),
  );
  assert.doesNotMatch(text, /After weighing the points/);
  for (const skill of SKILLS)
    assert.doesNotMatch(skill.text, /after interpreting/i, skill.name);
});

test('every skill gets the presentation rules; three have an answer template', () => {
  const templates = {
    translation: 'Part 2. The answer (the note level controls it)',
    exegesis: 'Exegesis answer\n- Give, for each literary unit',
    comparison: 'Presenting witnesses\n',
  };
  for (const skill of SKILLS) {
    assert.ok(
      skill.text.includes(
        'Presentation shows the outcome; it never changes what is investigated, weighed or concluded',
      ),
      skill.name,
    );
    assert.ok(
      skill.text.includes('use exactly that name wherever you mean it'),
      skill.name,
    );
    for (const [name, template] of Object.entries(templates))
      assert.equal(
        skill.text.split(template).length - 1,
        skill.name === name ? 1 : 0,
        `${skill.name}: ${name}`,
      );
  }
});

test('a conclusion check asked for on its own shows every interpretation', () => {
  const text = guidance('conclusion-check').text;
  for (const rule of [
    'check each conclusion against every part of the statement',
    'Read a passage from the scriptural basis only when the part of the statement it supports matters for that conclusion',
    'Asked for on its own, name the statement with its version',
    'for each interpretation say what it implies about God',
    'Run as part of an exegesis, the answer shows of this check only what the exegesis skill says',
    'an act must be good simply because a reading attributes it to God',
    'if you find no tension, say so and why',
    'reject it as unacceptable',
    'a reading never redefines that character',
    'when that stays uncertain, do not reject it',
    'check every serious interpretation or alternative, not only the one you favour',
    'a check of the favoured one alone is incomplete',
    'Read the statement with it before you form an explanation of your own',
  ])
    assert.ok(text.includes(rule), rule);
  assert.doesNotMatch(text, /do not write about the check/);
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
    '- When a reading seems not to fit',
    'exegesis',
    'conclusion-check',
  );
  for (const name of ['exegesis', 'comparison'])
    for (const rule of TRANSLATION_RULES)
      assert.ok(guidance(name).text.includes(`- ${rule}`), name);
});
