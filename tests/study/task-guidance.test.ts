import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolHandler} from '../../packages/shared/src/platform.ts';
import {skillFile} from '../../packages/shared/src/skills.ts';
import {
  MODES,
  study,
  type Mode,
  type StudyRequest,
} from '../../services/study/src/coordinator.ts';
import {
  guidance,
  TASKS,
  taskGuidance,
  TRANSLATION_RULES,
  type TaskGuidance,
} from '../../services/study/src/guidance.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import type {BudgetUsage} from '../../services/study/src/read/budget.ts';
import type {Batch} from '../../services/study/src/results/batch.ts';
import {call} from '../shared/mcp-call.ts';
import {
  readSkills,
  SKILLS_EXTENSION,
  skillSupport,
} from '../shared/mcp-skills.ts';
import {addAids} from './aid-fixture.ts';
import {allBatches} from './all-batches.ts';
import {buildFixture} from './fixture.ts';
import {buildPassageFixture, HEB} from './passage-fixture.ts';

const CAP = 16384;
const NAMES = ['comparison', 'exegesis', 'theme', 'translation', 'word-study'];

type Delivered = Batch & {task_guidance?: TaskGuidance};

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

/** What a study delivered over all its batches, apart from where it was split. */
function delivered(batches: Delivered[]) {
  const evidence = new Map<string, string>();
  for (const item of batches.flatMap(batch => batch.evidence)) {
    if (item.kind === 'search_hit')
      evidence.set(item.hit.occurrence_id, item.hit.form ?? '');
    else {
      const id = item.span.span_id;
      evidence.set(
        id,
        (evidence.get(id) ?? '') + (item.span.text ?? []).join(),
      );
    }
  }
  // Statements on the evidence itself; the mode's own note and where a batch ended may differ.
  const statements = batches
    .flatMap(batch => batch.limitations)
    .filter(l => !['budget', 'unsupported_capability'].includes(l.state))
    .map(l => `${l.state} ${l.scope} ${l.detail}`);
  const searched = batches
    .flatMap(batch => batch.searched_scope)
    .map(s => `${s.source_revision_id} ${s.capability} ${s.coverage_state}`);
  return {
    evidence: [...evidence].sort(),
    statements: [...new Set(statements)].sort(),
    searched: [...new Set(searched)].sort(),
  };
}

function words() {
  const f = buildFixture({
    commonCount: 80,
    strongLemmas: {common: 'G3686', beta: 'G2264G'},
  });
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      text: 'invented lexical entry '.repeat(1500),
      details: {strong_base: 'G3686', entry_id: 'long'},
    },
    {
      kind: 'proper_name',
      provider: 'synthetic TIPNR',
      details: {disambiguated_strong: 'G2264G', identity: 'Invented'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  return f.env;
}

const passage = () => buildPassageFixture().env;
const lead = (lookup: string, key: string) => ({
  search_leads: [{lookup, key}],
});

const STUDIES: [string, typeof passage, Omit<StudyRequest, 'mode'>, Mode[]][] =
  [
    [
      'a passage',
      passage,
      {references: ['Gen 1']},
      ['passage', 'exegesis', 'comparison', 'theme', 'word_study'],
    ],
    [
      'an occurrence search',
      words,
      lead('word', 'common'),
      ['theme', 'word_study', 'word_analysis', 'exegesis'],
    ],
    [
      'a long lexicon entry',
      words,
      lead('lexicon', 'G3686'),
      ['word_study', 'word_analysis', 'exegesis'],
    ],
  ];

for (const [name, fixture, request, modes] of STUDIES)
  for (const mode of modes)
    test(`${name} in ${mode} carries its guidance first and still delivers everything`, async () => {
      // A translation of the same request carries no task guidance: the measure to compare with.
      const plain = await allBatches<Delivered>(
        fixture(),
        {mode: 'translation', ...request},
        60,
      );
      const batches = await allBatches<Delivered>(
        fixture(),
        {mode, ...request},
        60,
      );
      const [first, ...later] = batches;
      assert.deepEqual(first.task_guidance, taskGuidance(mode));
      const translating = ['passage', 'exegesis', 'comparison'].includes(mode);
      assert.deepEqual(
        first.translation_rules,
        'references' in request && translating
          ? [...TRANSLATION_RULES]
          : undefined,
      );
      assert.ok(first.evidence.length > 0);
      for (const batch of later) {
        assert.equal(batch.task_guidance, undefined);
        assert.equal(batch.translation_rules, undefined);
        assert.ok(batch.evidence.length > 0, 'a continuation advances');
      }
      for (const batch of batches)
        assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= CAP);
      const tokens = batches.map(batch => batch.continuation);
      assert.equal(new Set(tokens).size, tokens.length);
      assert.deepEqual(delivered(batches), delivered(plain));
    });

test('a name study carries the word-study guidance first and reaches the occurrences', async () => {
  const batches = await allBatches<Delivered>(words(), {
    mode: 'word_study',
    ...lead('proper_name', 'G2264G'),
  });
  assert.equal(batches[0].task_guidance?.topic, 'word-study');
  const kinds = batches.flatMap(batch => batch.evidence.map(e => e.kind));
  assert.ok(kinds.includes('language_aid') && kinds.includes('search_hit'));
  for (const batch of batches)
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= CAP);
});

/** The passage fixture with verses about as large as real word-tagged ones as delivered
 *  (about 1.3 kB), one of them far larger through its textual note. */
function largeVerses() {
  const {env, db} = buildPassageFixture();
  db.sqlite
    .prepare('UPDATE source_nodes SET attribution = ?')
    .run('synthetic attribution and licence '.repeat(20));
  // Records of a selected release cannot change: add the note while nothing is selected.
  const select = db.sqlite.prepare(
    'UPDATE release_selection SET current_release_id = ? WHERE singleton_id = 1',
  );
  select.run(null);
  db.sqlite
    .prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'note-2',
      'evidence:heb1',
      HEB,
      'evidence:heb1#Gen.1.2',
      'textual_variants',
      'syn-provider',
      '{}',
      JSON.stringify({words: ['synthetic variant '.repeat(200)]}),
    );
  select.run('rel-p');
  return env;
}

test('verses as large as real ones still arrive from the first batch on, with the guidance attached', async () => {
  // One verse of about 5 kB, larger than the largest seen in the live data, arrives at once.
  for (const mode of MODES.filter(mode => taskGuidance(mode))) {
    const first = (await study(largeVerses(), {
      mode,
      depth: 'focused',
      references: ['Gen 1:2'],
      sources: [HEB],
    })) as unknown as Delivered;
    assert.ok(first.task_guidance, mode);
    assert.ok(Buffer.byteLength(JSON.stringify(first.evidence)) > 4500, mode);
  }
  for (const mode of ['passage', 'exegesis', 'comparison'] as const) {
    const batches = await allBatches<Delivered>(
      largeVerses(),
      {mode, references: ['Gen 1']},
      60,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(batches[0].evidence)) > 4000);
    for (const batch of batches) {
      assert.ok(batch.evidence.length > 0, `${mode}: every batch advances`);
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= CAP);
    }
    // Genesis 1 has 31 verses.
    assert.equal(delivered(batches).evidence.length, 31, mode);
  }
});

test('guidance in a first batch costs no extra database or object reads', async () => {
  for (const [fixture, request] of [
    [passage, {references: ['Gen 1']}],
    [words, lead('word', 'common')],
    [words, lead('lexicon', 'G3686')],
  ] as [typeof passage, Omit<StudyRequest, 'mode'>][]) {
    const reads = async (mode: Mode) => {
      let usage: BudgetUsage | undefined;
      await study(fixture(), {mode, ...request}, u => (usage = u));
      return usage!;
    };
    const plain = await reads('translation');
    for (const mode of ['exegesis', 'word_study', 'theme'] as const) {
      const used = await reads(mode);
      assert.ok(used.d1Calls <= plain.d1Calls, `${mode} D1`);
      assert.ok(used.r2Reads <= plain.r2Reads, `${mode} R2`);
    }
  }
});

test('modes without a task and failed requests carry no guidance', async () => {
  const env = passage();
  for (const request of [
    {mode: 'inspect_source', references: ['Gen 1:1'], sources: ['x']},
    {mode: 'conclusion_check'},
    {mode: 'exegesis', references: ['Nowhere 1']},
  ] as StudyRequest[]) {
    const result = (await study(env, request)) as unknown as Delivered;
    assert.equal(result.task_guidance, undefined, request.mode);
  }
});
