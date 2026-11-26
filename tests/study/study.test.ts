import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_VERSIONS,
  protocolHandler,
} from '../../packages/shared/src/platform.ts';
import {study} from '../../services/study/src/coordinator.ts';
import {
  STUDY_INSTRUCTIONS,
  GUIDANCE_VERSION,
} from '../../services/study/src/guidance.ts';
import {studyServer} from '../../services/study/src/mcp.ts';
import {normalizeKey} from '../../services/study/src/scope/keys.ts';
import {
  candidateUnits,
  parseReference,
} from '../../services/study/src/scope/references.ts';
import {allBatches} from './all-batches.ts';
import {buildFixture, A} from './fixture.ts';
import {buildPassageFixture, GRK, HEB, wording} from './passage-fixture.ts';
import {call as rpc} from '../shared/mcp-call.ts';

type Item = {
  kind: string;
  role?: string;
  span: {
    span_id: string;
    label: string;
    text: string[] | null;
    segments: {unit_id: string}[];
  };
  annotations?: unknown[];
};
type AnyBatch = {
  evidence: Item[];
  limitations: {state: string; scope: string; detail: string}[];
  continuation: string | null;
  context_scope?: unknown;
  release_id?: string;
};

const all = (
  env: Parameters<typeof study>[0],
  request: Parameters<typeof study>[1],
  max?: number,
) => allBatches<AnyBatch>(env, request, max);
const units = (batches: AnyBatch[]) =>
  batches.flatMap(b => b.evidence.map(e => e.span.segments[0].unit_id));

test('references parse into native unit candidates; unknown books and bad ranges are refused', () => {
  assert.deepEqual(parseReference('Gen 1:1-2:3'), {
    text: 'Gen 1:1-2:3',
    book: 'Gen',
    from: {chapter: 1, verse: 1},
    to: {chapter: 2, verse: 3},
  });
  assert.deepEqual(parseReference('Genesis 1').to, {chapter: 1, verse: null});
  assert.equal(parseReference('Mt 5:3-12').book, 'Mat');
  assert.equal(parseReference('1 John 1:1').book, '1Jn');
  assert.equal(parseReference('II Kings 2').book, '2Ki');
  assert.equal(parseReference('Psalm 119').book, 'Psa');
  assert.deepEqual(candidateUnits(parseReference('Mt 5:3-5')), [
    'Mat.5.3',
    'Mat.5.4',
    'Mat.5.5',
  ]);
  assert.equal(candidateUnits(parseReference('Gen 1-2')).length, 360);
  for (const bad of [
    'Hezekiah 1:1',
    'Gen 2:1-1:3',
    'Gen 1:5-3',
    'Gen 1-4',
    'nonsense',
    '',
  ])
    assert.throws(
      () => parseReference(bad),
      /reference|book|order|chapters|text/i,
      bad,
    );
});

test('host keys are normalized like the stored keys', () => {
  assert.equal(normalizeKey('word', 'Λόγος'), 'λογοσ');
  assert.equal(normalizeKey('word', 'κἀγώ'), 'καγω');
  const pointed = String.fromCodePoint(
    0x5d1,
    0x5bc,
    0x5b0,
    0x5e8,
    0x5b5,
    0x5d0,
    0x5e9,
    0x5c1,
    0x5b4,
    0x596,
    0x5d9,
    0x5ea,
  );
  assert.equal(
    normalizeKey('form', pointed),
    pointed.replace(String.fromCodePoint(0x596), '').normalize('NFC'),
    'accent removed, points kept',
  );
  assert.equal(normalizeKey('lemma', ' H7225 '), 'H7225');
});

test('a passage delivers the asked verses and the whole chapter, in native order, across batches without loss', async () => {
  const {env, bucket} = buildPassageFixture();
  bucket.reads.length = 0;
  const batches = await all(env, {
    mode: 'translation',
    references: ['Gen 1:3-4'],
    sources: [HEB],
  });
  const delivered = units(batches);
  assert.deepEqual(
    delivered,
    Array.from({length: 31}, (_, i) => `Gen.1.${i + 1}`),
    'whole NRSVA chapter once, in order',
  );
  const items = batches.flatMap(b => b.evidence);
  assert.deepEqual(
    items
      .filter(i => i.role === 'requested')
      .map(i => i.span.segments[0].unit_id),
    ['Gen.1.3', 'Gen.1.4'],
  );
  assert.equal(
    items.find(i => i.span.segments[0].unit_id === 'Gen.1.7')!.span.text![0],
    wording('Gen.1.7'),
  );
  assert.ok(batches.length > 1, 'the chapter needs more than one batch');
  assert.ok(
    batches[0].limitations.some(
      l => l.state === 'missing_evidence' && l.scope === 'literary_unit',
    ),
  );
  const noted = items.find(i => i.span.segments[0].unit_id === 'Gen.1.2')!;
  assert.deepEqual(
    (noted.annotations as {kind: string}[]).map(a => a.kind),
    ['textual_variants'],
  );
  // One body read per batch at most: neighbouring verses are read together.
  assert.ok(
    bucket.reads.length <= batches.length * 4,
    `${bucket.reads.length} reads for ${batches.length} batches`,
  );
  for (const batch of batches) assert.equal(batch.release_id, 'rel-p');
});

test('a range across two prepared units, focused depth and several references', async () => {
  const {env} = buildPassageFixture();
  const across = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Gen 1:30-2:2'],
    sources: [HEB],
  });
  assert.deepEqual(units(across), [
    'Gen.1.30',
    'Gen.1.31',
    'Gen.2.1',
    'Gen.2.2',
  ]);
  assert.equal(across[0].context_scope, null);
  const two = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Mat 1:2', 'Gen 2:5'],
  });
  assert.deepEqual(units(two), ['Mat.1.2', 'Gen.2.5']);
});

test('sources are kept apart; a reference no source has is reported, not filled', async () => {
  const {env} = buildPassageFixture();
  const [none] = await all(env, {
    mode: 'passage',
    references: ['Gen 1:1'],
    sources: [GRK],
  });
  assert.equal(none.evidence.length, 0);
  assert.ok(
    none.limitations.some(
      l => l.state === 'missing_evidence' && l.scope === 'Gen.1.1',
    ),
  );
  const [missing] = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Exo 3:14'],
  });
  assert.ok(
    missing.limitations.some(
      l =>
        l.state === 'missing_evidence' && /No checked mapping/.test(l.detail),
    ),
  );
  const [only] = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Gen 1:1'],
    sources: [HEB],
  });
  assert.deepEqual(units([only]), ['Gen.1.1']);
});

test('a verse whose stored wording fails its check is withheld alone', async () => {
  const {env, db} = buildPassageFixture();
  // Make the recorded digest of Gen 1:2 wrong; its neighbours share the same read.
  const row = db.sqlite
    .prepare(
      `SELECT body_ranges_json FROM native_spans WHERE id = 'evidence:heb1#Gen.1.2'`,
    )
    .get() as {body_ranges_json: string};
  const ranges = JSON.parse(row.body_ranges_json);
  ranges[0].sha256 = '0'.repeat(64);
  db.sqlite.exec('DROP TRIGGER IF EXISTS native_spans_immutable');
  for (const name of db.sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'native_spans'`,
    )
    .all() as {name: string}[])
    db.sqlite.exec(`DROP TRIGGER ${name.name}`);
  db.sqlite
    .prepare(
      `UPDATE native_spans SET body_ranges_json = ? WHERE id = 'evidence:heb1#Gen.1.2'`,
    )
    .run(JSON.stringify(ranges));
  const [batch] = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Gen 1:1-3'],
  });
  const byUnit = new Map(
    batch.evidence.map(i => [i.span.segments[0].unit_id, i.span.text]),
  );
  assert.deepEqual(byUnit.get('Gen.1.1'), [wording('Gen.1.1')]);
  assert.equal(byUnit.get('Gen.1.2'), null);
  assert.deepEqual(byUnit.get('Gen.1.3'), [wording('Gen.1.3')]);
  assert.ok(batch.limitations.some(l => l.state === 'corrupt'));
});

test('a changed or foreign continuation is rejected before any read', async () => {
  const {env} = buildPassageFixture();
  const first = (await study(env, {
    mode: 'translation',
    references: ['Gen 1'],
  })) as AnyBatch;
  assert.ok(first.continuation);
  const foreign = (await study(env, {
    mode: 'translation',
    references: ['Gen 2'],
    continuation: first.continuation!,
  })) as AnyBatch;
  assert.match(foreign.limitations[0].detail, /different workload/);
  const altered =
    first.continuation!.slice(0, -2) +
    (first.continuation!.endsWith('A') ? 'BB' : 'AA');
  const bad = (await study(env, {
    mode: 'translation',
    references: ['Gen 1'],
    continuation: altered,
  })) as AnyBatch;
  assert.equal(bad.limitations[0].state, 'invalid_request');
});

test('word, lemma and form searches go through the search interface; unsupported lookups say so', async () => {
  const {env} = buildFixture();
  const batches = await all(env, {
    mode: 'word_study',
    search_leads: [{lookup: 'word', key: 'alpha'}],
  });
  const hits = batches.flatMap(
    b =>
      b.evidence as unknown as {
        kind: string;
        hit: {source_revision_id: string};
      }[],
  );
  assert.ok(hits.length > 0 && hits.every(h => h.kind === 'search_hit'));
  assert.ok(hits.some(h => h.hit.source_revision_id === A));
  const lemma = await all(env, {
    mode: 'word_study',
    search_leads: [{lookup: 'lemma', key: 'prov-a:lemma-beta'}],
  });
  assert.equal(lemma.flatMap(b => b.evidence).length, 1);
  const [phrase] = await all(env, {
    mode: 'word_study',
    search_leads: [{lookup: 'phrase', key: 'alpha beta'}],
  });
  assert.equal(phrase.evidence.length, 0);
  assert.ok(phrase.limitations.some(l => l.state === 'unsupported_capability'));
  const [two] = await all(env, {
    mode: 'word_study',
    search_leads: [
      {lookup: 'word', key: 'a'},
      {lookup: 'word', key: 'b'},
    ],
  });
  assert.equal(two.limitations[0].state, 'invalid_request');
});

test('modes without loaded evidence say so; conclusion_check returns the statement or its absence', async () => {
  const {env} = buildPassageFixture();
  const [comparison] = await all(env, {
    mode: 'comparison',
    depth: 'focused',
    references: ['Gen 1:1'],
  });
  assert.ok(
    comparison.limitations.some(
      l =>
        l.state === 'unsupported_capability' &&
        /not assumed to correspond/.test(l.detail),
    ),
  );
  const absent = (await study(env, {mode: 'conclusion_check'})) as {
    statement: unknown;
    limitations: {state: string}[];
  };
  assert.equal(absent.statement, null);
  assert.equal(absent.limitations[0].state, 'missing_evidence');
  const present = (await study(buildFixture().env, {
    mode: 'conclusion_check',
  })) as {statement: {name: string; version: string}};
  assert.deepEqual(
    [present.statement.name, present.statement.version],
    ['Synthetic statement', '1'],
  );
  assert.doesNotMatch(JSON.stringify(present), /private:approval-ref/);
  const [nothing] = await all(env, {mode: 'exegesis'});
  assert.equal(nothing.limitations[0].state, 'invalid_request');
});

test('both tools work on the baseline protocol, read-only, with guidance sent on initialize', async () => {
  const {env} = buildPassageFixture();
  const handler = protocolHandler(() => studyServer(env, false), false);
  const init = await rpc(handler, 'initialize', {
    protocolVersion: LEGACY_VERSIONS[0],
    capabilities: {},
    clientInfo: {name: 'host', version: '1'},
  });
  assert.equal(init.result.instructions, STUDY_INSTRUCTIONS);
  const {result} = await rpc(handler, 'tools/list');
  assert.deepEqual(result.tools.map((t: {name: string}) => t.name).sort(), [
    'get_guidance',
    'study',
  ]);
  for (const tool of result.tools)
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  const called = await rpc(handler, 'tools/call', {
    name: 'study',
    arguments: {mode: 'passage', depth: 'focused', references: ['Mat 1:1-3']},
  });
  const batch = JSON.parse(called.result.content[0].text);
  assert.deepEqual(
    batch.evidence.map((e: Item) => e.span.label),
    ['Mat 1:1', 'Mat 1:2', 'Mat 1:3'],
  );
  assert.equal(batch.guidance_version, GUIDANCE_VERSION);
  const failed = await rpc(handler, 'tools/call', {
    name: 'study',
    arguments: {mode: 'passage', references: ['Nowhere 1:1']},
  });
  assert.equal(failed.result.isError, true);
  const guide = await rpc(handler, 'tools/call', {
    name: 'get_guidance',
    arguments: {topic: 'method'},
  });
  assert.match(JSON.parse(guide.result.content[0].text).text, /circular/);
  const invalid = await rpc(handler, 'tools/call', {
    name: 'study',
    arguments: {mode: 'sermon'},
  });
  assert.ok(invalid.error || invalid.result.isError);
  await handler.close();
});

test('Study MCP reuses a full passage, including notes, after its D1 allowance is spent', async t => {
  const events: unknown[] = [];
  t.mock.method(console, 'log', (entry: unknown) => {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'event' in entry &&
      entry.event === 'study_d1_cache'
    )
      events.push(entry);
  });
  const {env, db} = buildPassageFixture();
  const prepare = db.prepare.bind(db);
  const reads: string[] = [];
  db.prepare = sql => {
    reads.push(sql);
    return prepare(sql);
  };
  const handler = protocolHandler(() => studyServer(env, false), false);
  try {
    await rpc(handler, 'initialize', {
      protocolVersion: LEGACY_VERSIONS[0],
      capabilities: {},
      clientInfo: {name: 'host', version: '1'},
    });
    const args = {
      name: 'study',
      arguments: {mode: 'passage', depth: 'focused', references: ['Gen 1:2']},
    };
    const first = await rpc(handler, 'tools/call', args);
    const batch = JSON.parse(first.result.content[0].text) as AnyBatch;
    assert.equal(batch.evidence.length, 1);
    assert.equal(batch.evidence[0].annotations?.length, 1);
    assert.equal(batch.continuation, null);
    assert.equal(
      reads.length,
      4,
      'first call reads current, coverage, spans and notes',
    );

    env.MAX_D1_CALLS = 1;
    reads.length = 0;
    const repeated = await rpc(handler, 'tools/call', args);
    assert.deepEqual(JSON.parse(repeated.result.content[0].text), batch);
    assert.equal(reads.length, 1);
    assert.match(reads[0], /FROM release_selection/);
    assert.deepEqual(events, [
      {
        event: 'study_d1_cache',
        hits: 0,
        misses: 3,
        d1_calls: 4,
        d1_rows_read: 0,
      },
      {
        event: 'study_d1_cache',
        hits: 3,
        misses: 0,
        d1_calls: 1,
        d1_rows_read: 0,
      },
    ]);
  } finally {
    await handler.close();
  }
});

function dropTriggers(db: ReturnType<typeof buildPassageFixture>['db']) {
  for (const t of db.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    .all() as {name: string}[])
    db.sqlite.exec(`DROP TRIGGER ${t.name}`);
}

test('R35-1: verses missing from an asked range are reported, also when context exists', async () => {
  const {env, db} = buildPassageFixture();
  dropTriggers(db);
  db.sqlite
    .exec(`DELETE FROM annotation_rows WHERE span_id = 'evidence:heb1#Gen.1.2'; DELETE FROM span_segments WHERE span_id = 'evidence:heb1#Gen.1.2';
    DELETE FROM native_spans WHERE id = 'evidence:heb1#Gen.1.2'`);
  const [gap] = await all(env, {
    mode: 'inspect_source',
    references: ['Gen 1:1-3'],
    sources: [HEB],
  });
  assert.deepEqual(units([gap]), ['Gen.1.1', 'Gen.1.3']);
  assert.ok(
    gap.limitations.some(
      l =>
        l.state === 'missing_evidence' && /no verse Gen 1:2\b/.test(l.detail),
    ),
    JSON.stringify(gap.limitations),
  );
  const beyond = await all(env, {
    mode: 'translation',
    references: ['Gen 1:99'],
  });
  assert.equal(
    beyond[0].limitations[0].state,
    'invalid_request',
    'reader references beyond the catalogue are rejected',
  );
  const tail = await all(env, {
    mode: 'inspect_source',
    references: ['Gen 2:4-7'],
    sources: [HEB],
  });
  assert.ok(
    tail[0].limitations.some(l => /no verse Gen 2:6-7/.test(l.detail)),
    JSON.stringify(tail[0].limitations),
  );
});

test('missing ranges: gaps, missing chapters and an explicit end; an unknown chapter end is not a gap', async () => {
  const {missingRanges} =
    await import('../../services/study/src/operators/passage.ts');
  const ref = parseReference('Gen 1:2-3:4');
  assert.deepEqual(
    missingRanges(ref, ['Gen.1.2', 'Gen.1.4', 'Gen.1.5', 'Gen.3.2', 'Gen.3.3']),
    ['Gen 1:3', 'Gen 2', 'Gen 3:1', 'Gen 3:4'],
  );
  assert.deepEqual(
    missingRanges(parseReference('Gen 1'), ['Gen.1.1', 'Gen.1.2', 'Gen.1.3']),
    [],
  );
  assert.deepEqual(missingRanges(parseReference('Gen 1:5'), []), ['Gen 1:5']);
  // R35-3: nothing found in the first chapter of a cross-chapter range.
  assert.deepEqual(
    missingRanges(parseReference('Gen 1:99-2:2'), ['Gen.2.1', 'Gen.2.2']),
    ['Gen 1:99 to the end of chapter 1'],
  );
  assert.deepEqual(missingRanges(parseReference('Gen 1:2-3:1'), ['Gen.3.1']), [
    'Gen 1:2 to the end of chapter 1',
    'Gen 2',
  ]);
});

test('R35-2: a missing or malformed body withholds only its verses; independent evidence is delivered', async () => {
  const {env, bucket, db} = buildPassageFixture();
  bucket.objects.delete('synthetic/body/evidence:heb2');
  const [batch] = await all(env, {
    mode: 'inspect_source',
    references: ['Gen 1:40-2:2'],
    sources: [HEB],
  });
  const text = new Map(
    batch.evidence.map(i => [i.span.segments[0].unit_id, i.span.text]),
  );
  assert.deepEqual(text.get('Gen.1.40'), [wording('Gen.1.40')]);
  assert.equal(text.get('Gen.2.1'), null);
  assert.equal(text.get('Gen.2.2'), null);
  assert.ok(
    batch.limitations.some(l => l.state === 'corrupt' && l.scope === 'Gen 2:1'),
  );
  dropTriggers(db);
  const row = db.sqlite
    .prepare(
      `SELECT body_ranges_json FROM native_spans WHERE id = 'evidence:heb1#Gen.1.5'`,
    )
    .get() as {body_ranges_json: string};
  const ranges = JSON.parse(row.body_ranges_json);
  ranges[0].byte_offset = -3;
  db.sqlite
    .prepare(
      `UPDATE native_spans SET body_ranges_json = ? WHERE id = 'evidence:heb1#Gen.1.5'`,
    )
    .run(JSON.stringify(ranges));
  const [malformed] = await all(env, {
    mode: 'inspect_source',
    references: ['Gen 1:4-6'],
    sources: [HEB],
  });
  assert.deepEqual(units([malformed]), ['Gen.1.4', 'Gen.1.6']);
  assert.ok(
    malformed.limitations.some(
      l => l.state === 'corrupt' && /malformed/.test(l.detail),
    ),
  );
});

test('R35-3 and R35-4: a missing first chapter and a named source without the verses are reported', async () => {
  const {env} = buildPassageFixture();
  const [cross] = await all(env, {
    mode: 'inspect_source',
    references: ['Gen 1:99-2:2'],
    sources: [HEB],
  });
  assert.deepEqual(units([cross]), ['Gen.2.1', 'Gen.2.2']);
  assert.ok(
    cross.limitations.some(
      l =>
        l.state === 'missing_evidence' &&
        /Gen 1:99 to the end of chapter 1/.test(l.detail),
    ),
    JSON.stringify(cross.limitations),
  );
  const [mixed] = await all(env, {
    mode: 'passage',
    depth: 'focused',
    references: ['Gen 1:1'],
    sources: [HEB, GRK],
  });
  assert.deepEqual(units([mixed]), ['Gen.1.1']);
  assert.ok(
    mixed.limitations.some(
      l => l.state === 'missing_evidence' && l.detail.startsWith(`${GRK}:`),
    ),
    JSON.stringify(mixed.limitations),
  );
});

test('a translating study carries the key translation rules in its first batch only', async () => {
  const {env} = buildPassageFixture();
  const {TRANSLATION_RULES, guidance} =
    await import('../../services/study/src/guidance.ts');
  const batches = (await all(env, {
    mode: 'translation',
    references: ['Gen 1'],
  })) as (AnyBatch & {translation_rules?: string[]})[];
  assert.ok(batches.length > 1);
  assert.deepEqual(batches[0].translation_rules, [...TRANSLATION_RULES]);
  for (const later of batches.slice(1))
    assert.equal(later.translation_rules, undefined);
  const [inspect] = (await all(env, {
    mode: 'inspect_source',
    references: ['Gen 1:1'],
  })) as (AnyBatch & {translation_rules?: string[]})[];
  assert.equal(inspect.translation_rules, undefined);
  const rules = TRANSLATION_RULES.join('\n');
  for (const needed of [
    /Yahweh/,
    /never LORD or HEERE/,
    /Werkvertaling/,
    /ESV, NASB/,
    /Decide key terms and the winning reading/,
    /traditions are evidence, not the answer/,
    /⚑/,
    /square brackets/,
    /Follow the asked scope/,
    /Concise: no footnotes and no explanation, except the Concise exceptions/,
    /Limits:/,
    /Footnotes \(standard and full\)/,
    /Voetnoten/,
    /Unicode small-cap letters/,
    /Unicode superscript digits/,
    /never decides which reading is translated/,
    /read the quoted passages and the quoting passages/,
    /could not be finished because a witness is missing/,
    /unless the reader asks how a reading was chosen/,
    /give its argument in one or two sentences before the translation at standard and full, and do not write it at concise/,
    /topic "translation"/,
    /chapter heading/,
    /State the basis of each choice in one clause/,
    /Wording may differ between runs and levels/,
    /in italics each supplied word/,
    /outside knowledge, unchecked/,
    /Edition flags are not manuscript evidence/,
  ])
    assert.match(rules, needed);
  const full = guidance('translation').text;
  for (const needed of [
    /YHWH is always "Yahweh"/,
    /wild and waste/,
    /kyrios/,
    /aion\/aionios/,
    /Gehenna/,
    /lexical range/,
    /Key terms/,
    /Traditions are evidence, not the answer/,
    /Check before delivering/,
    /concerns dualism only/,
    /\+2 the reading that best explains/,
    /-2 a reading that steers the theology/,
    /earns no points/,
    /New Testament quotations decide/,
    /do not show scores, points or checks unless the reader asks how a reading was chosen/,
    /weighed, not counted/,
    /not an allusion or echo/,
    /tiqqune sopherim/,
    /Keep Hebrew idioms in the text as written/,
    /mark it as a reconstruction/,
    /exaggerates or glorifies/,
    /On a tie in the Old Testament, translate the Masoretic Text/,
    /ask which edition to translate/,
    /Longer text that does not win goes in \[square brackets\] with a footnote, whatever its kind/,
    /Only when the difference is too large to bracket/,
    /a single added line \(the ending of the Lord's Prayer in Matthew 6:13\)/,
    /follow established scholarly assessments where known/,
    /if it is one of the tied readings/,
    /a tie without the Masoretic Text, a New Testament tie/,
    /provisional translation; say plainly that the evidence does not settle it/,
    /a debated boundary range is shown as possible kaige and not discounted/,
    /whose own reading differs, or whose clear omission is attested, at those words/,
    /Without such a witness the flagged reading is the only usable Greek reading: keep it/,
    /an edition that only names manuscripts/,
    /mark it with its actual label/,
    /A range mark alone does not discount a reading the non-kaige witnesses share/,
    /only after checking their wording and source at that passage/,
  ])
    assert.match(full, needed);
  assert.match(STUDY_INSTRUCTIONS, /topic "translation"/);
  for (const needed of [
    /numbered footnotes/i,
    /Sources: a one-line Sources line/,
    /STEP Bible/,
    /Logeion/,
    /Open Scriptures Hebrew Lexicon/,
    /chosen rendering follows from the evidence/,
    /consult only these agreed external websites/,
    /If a longer reading wins, do not bracket it; footnote a consequential difference/,
    /normal-size verse numbers/,
    /verse numbers outside/,
    /small caps/,
    /raised numbered footnote marker/,
    /When Scripture directly quotes other Scripture/,
    /not allusions or echoes/,
    /q becomes ǫ/,
    /shorter quotations stay inline/,
  ])
    assert.match(full, needed);
  assert.doesNotMatch(full, /no brackets or footnote for that difference/);
  for (const needed of [
    /none of this appears at concise except as listed here/,
    /Standard \(the default\)/,
    /Full adds depth to each footnote, not more footnotes/,
    /explicit request for another amount or format of explanation replaces the defaults/,
    /Required attribution and material limitations always stay/,
    /Wording may differ between runs and levels/,
    /say what changed and why/,
    /ordinary language and context/,
    /translation only/,
    /thorough/,
    /not exhaustive/,
    /use standard without asking/,
    /unclear or conflicting/,
    /A level never changes the study tool's depth setting/,
    /At every level make the same Study tool calls, follow every continuation, read the same evidence/,
    /Make outside lookups only for a question that needs one/,
    /the unit argument before the translation \(standard and full only\)/,
    /Concise exceptions/,
    /Part 1\. Read and decide/,
    /Part 2\. The answer/,
  ])
    assert.match(full, needed);
  assert.doesNotMatch(full, /section A|decision 0019|proposal/i);
  assert.equal(GUIDANCE_VERSION, 'study-guidance/24');
  for (const needed of [
    /### Working translation — <reference>/,
    /#### <chapter heading: book and chapter, only when several chapters>/,
    /##### <section heading: optional, no scripture reference; ####, one level below the title/,
    /### Footnotes/,
    /¹ <chapter:verse> — /,
    /Sources: <one line>/,
    /Limits: <one line>/,
    /Elsewhere:/,
    /Traditions:/,
    /Effect:/,
    /Footnote slots/,
    /The title never names the level/,
    /one heading level below the chapter heading/,
    /This is the one place the book name repeats/,
    /A passage outside the unit is always named in full/,
    /never cut for length/,
    /Clarity comes before brevity/,
    /The script-and-transliteration slot applies only where there is an original-language word to show/,
    /the evidence does not decide; X is followed because/i,
    /not manuscript evidence/,
    /never invent one/,
    /Treat witnesses as one voice only where the evidence shows they go back to one text-form/,
    /The same distinction applies in Dutch/,
    /italic small caps/,
  ])
    assert.match(full, needed);
  assert.doesNotMatch(
    full,
    /give the same translation at every level|how settled it is: a close call/,
  );
  assert.doesNotMatch(rules, /same translation/);
});

test('the first-batch translation rules and the full topic share their tested wording', async () => {
  const {TRANSLATION_RULES, guidance} =
    await import('../../services/study/src/guidance.ts');
  const rules = TRANSLATION_RULES.join('\n');
  const full = guidance('translation').text;
  for (const phrase of [
    'asked scope',
    'Unicode small-cap letters',
    'Unicode superscript digits',
    'one-line Sources',
    'Limits:',
    'square brackets',
    'same Study tool calls',
    'research needed to decide',
    'without a footnote',
    'never decides which reading is translated',
    'more than one sentence',
    'each limitation in a few words',
    'chapter heading',
    'supplied word',
    'outside knowledge, unchecked',
    'Wording may differ between runs and levels',
    'the same footnoted choices',
    'not your process',
    'Voetnoten',
    'unless the reader asks how a reading was chosen',
    'read the quoted passages',
    'Concise exceptions',
    '⚑',
    'Keep it out of every translation decision',
    'give its argument in one or two sentences before the translation',
    'could not be finished because a witness is missing',
  ]) {
    assert.ok(rules.includes(phrase), `first-batch rules lack "${phrase}"`);
    assert.ok(full.includes(phrase), `full topic lacks "${phrase}"`);
  }
});

test('method and tools guidance state the context summary and the native candidate rules', async () => {
  const {guidance} = await import('../../services/study/src/guidance.ts');
  const method = guidance('method').text;
  assert.match(
    method,
    /read that unit fully \(across batches\) at every detail level/,
  );
  assert.match(
    method,
    /In a translation, give its argument in one or two sentences before the translation at standard and full, and do not write it at concise/,
  );
  assert.match(
    method,
    /In other study requests, summarise its argument before explaining the asked verses/,
  );
  assert.doesNotMatch(method, /summarise its argument before translating/);
  const tools = guidance('tools').text;
  assert.match(
    tools,
    /delivered_scope\.numbering_notes.*explain those numbering differences to the reader/,
  );
  assert.match(
    tools,
    /any native candidate the study returns is unverified, not a checked match/,
  );
  assert.match(
    tools,
    /Only when exact native text is still needed, inspect native numbering with mode "inspect_source"/,
  );
  assert.match(tools, /compound Hebrew morphology code, split the components/);
  assert.match(
    tools,
    /Across batches match separately delivered entries by lookup and key/,
  );
  assert.match(
    guidance('translation').text,
    /First retrieve the current project's relevant lexical entries and their continuations/,
  );
});
