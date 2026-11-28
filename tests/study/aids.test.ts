import assert from 'node:assert/strict';
import {test} from 'node:test';
import {A, buildFixture} from './fixture.ts';
import {addAids, aidKey} from './aid-fixture.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {limitsFor} from '../../services/study/src/read/budget.ts';
import {aidBatch} from '../../services/study/src/operators/aids.ts';
import {languageBatch} from '../../services/study/src/operators/language.ts';
import type {
  SearchAdapter,
  SearchHit,
} from '../../services/study/src/read/search.ts';
import {study} from '../../services/study/src/coordinator.ts';
import type {EvidenceItem} from '../../services/study/src/results/batch.ts';

function aids() {
  const f = buildFixture();
  f.select(null, null);
  const commit = 'a'.repeat(40);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      details: {
        entry_id: 'entry-one',
        strong_base: 'H1234',
        entry_key: 'entry-one',
      },
    },
    {
      kind: 'lexicon_entry',
      details: {
        entry_id: `oshb-lexical-index:${commit}:x`,
        strong_base: 'H1234',
        entry_key: 'entry-two',
        references: [
          ['a', '1234', null, null],
          ['b', null, null, null],
        ],
      },
    },
    {
      kind: 'grammar_expansion',
      details: {code: 'Ncmsa', entry_id: 'grammar-one'},
    },
  ]);
  addAids(f, 'syn-ev-old', [
    {
      kind: 'lexicon_entry',
      details: {entry_id: 'old', strong_base: 'H1234', entry_key: 'old'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  return f;
}

const workload = {
  mode: 'word_study',
  depth: 'standard',
  language: 'en',
  lookup: 'lexicon',
  key: 'H1234',
  sources: null,
};

test('lexical entries are attributed, retain alternatives and follow selected-release BDB links', async () => {
  const f = aids();
  const session = await ReadSession.open(f.env);
  const result = await aidBatch(session, workload, null, 'test');
  assert.equal(result.evidence.length, 2);
  const [a, b] = result.evidence;
  assert.equal(a.kind, 'language_aid');
  assert.equal(b.kind, 'language_aid');
  if (a.kind !== 'language_aid' || b.kind !== 'language_aid')
    throw new Error('missing aids');
  assert.equal(a.span.source_revision_id, A);
  assert.ok(a.span.text?.length);
  assert.deepEqual(b.details.linked_entry_keys, [
    `oshb-bdb:${'a'.repeat(40)}:a`,
    `oshb-bdb:${'a'.repeat(40)}:b`,
  ]);
  assert.equal(result.continuation, null);
});

test('pagination resumes in order and continuation rejects changed lookup', async () => {
  const f = aids();
  const limits = {...limitsFor({}, 'passage'), rowsPerQuery: 1};
  const first = await aidBatch(
    await ReadSession.open(f.env, limits),
    workload,
    null,
    'test',
  );
  assert.equal(first.evidence.length, 1);
  assert.ok(first.continuation);
  const second = await aidBatch(
    await ReadSession.open(f.env, limits),
    workload,
    first.continuation,
    'test',
  );
  assert.equal(second.evidence.length, 1);
  assert.equal(second.continuation, null);
  await assert.rejects(
    aidBatch(
      await ReadSession.open(f.env, limits),
      {...workload, key: 'H1235'},
      first.continuation,
      'test',
    ),
  );
});

test('Study routes exact grammar explanations and reports missing entries', async () => {
  const f = aids();
  const result = await study(f.env, {
    mode: 'word_analysis',
    search_leads: [{lookup: 'grammar_info', key: 'Ncmsa'}],
  });
  assert.equal(
    (result.evidence as Array<{kind: string}>)[0].kind,
    'language_aid',
  );
  const missing = await study(f.env, {
    mode: 'word_study',
    search_leads: [{lookup: 'lexicon', key: 'G1'}],
  });
  assert.equal(
    (missing.limitations as Array<{state: string}>)[0].state,
    'missing_evidence',
  );
});

test('long verified lexical bodies continue without loss and preserve exact source coordinates', async () => {
  const f = aids();
  f.select(null, null);
  const body = 'α😀 abc '.repeat(7800);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      text: body,
      details: {strong_base: 'G1234', entry_id: 'long'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  const batch = async (from: string | null = null) =>
    aidBatch(
      await ReadSession.open(f.env, limitsFor({}, 'aid')),
      {...workload, key: 'G1234'},
      from,
      'test',
    );
  const lineReads = () =>
    f.bucket.reads.filter(read => read.key === aidKey('syn-ev')).length;
  let next: string | null = null;
  const chunks: string[] = [];
  let expectedStart = -1; // The entry starts where it lies in its partition's native text.
  let priorReadCount = 0;
  for (let i = 0; i < 10; i++) {
    const result = await batch(next);
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) <=
        limitsFor({}, 'passage').resultBytes,
    );
    for (const item of result.evidence)
      if (item.kind === 'language_aid' && item.span.text![0].length > 1000) {
        if (expectedStart < 0) expectedStart = item.span.segments[0].start;
        assert.equal(item.span.segments[0].start, expectedStart);
        const text = item.span.text![0];
        expectedStart += Array.from(text).length;
        assert.equal(item.span.segments[0].end, expectedStart);
        chunks.push(text);
      }
    const longReads = lineReads();
    assert.ok(
      longReads > priorReadCount,
      'each part verifies the selected R2 line',
    );
    priorReadCount = longReads;
    next = result.continuation;
    if (!next) break;
  }
  assert.equal(next, null);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), body);
  const routed = await study(f.env, {
    mode: 'word_study',
    search_leads: [{lookup: 'lexicon', key: 'G1234'}],
  });
  assert.equal((routed.evidence as unknown[]).length, 1);
  assert.ok(
    routed.continuation,
    'Study selects the larger bounded allowance for language-aid retrieval',
  );
  const pending = await batch();
  assert.ok(pending.continuation);
  f.select('rel-1', 'rel-2');
  await assert.rejects(
    batch(pending.continuation),
    /Continuation entry is no longer selected/,
  );
  f.select('rel-2', 'rel-1');
  const beforeReselection = lineReads();
  await batch();
  assert.ok(
    lineReads() > beforeReselection,
    'reselected source is verified again after a release change',
  );
  f.bucket.corrupt.add(aidKey('syn-ev'));
  const corrupt = await batch();
  assert.equal(corrupt.evidence.length, 0);
  assert.ok(corrupt.limitations.some(item => item.state === 'corrupt'));
});

for (const {language, lemma, base, morphology, code} of [
  {
    language: 'hebrew',
    lemma: 'H7225G',
    base: 'H7225',
    morphology: 'Ncfsa',
    code: 'HNcfsa',
  },
  {
    language: 'hebrew',
    lemma: 'H7225G',
    base: 'H7225',
    morphology: 'Aamsa',
    code: 'HAamsa',
  },
  {
    language: 'aramaic',
    lemma: 'H1254A',
    base: 'H1254',
    morphology: 'R',
    code: 'AR',
  },
]) {
  test(`TAHOT-shaped ${language} ${morphology} word analysis attaches base Strong lexicon and language-prefixed grammar`, async () => {
    const f = aids();
    f.select(null, null);
    addAids(f, 'syn-ev', [
      {
        kind: 'lexicon_entry',
        provider: 'synthetic STEP lexicon',
        details: {entry_id: lemma, strong_base: base},
      },
      {
        kind: 'grammar_expansion',
        provider: 'synthetic STEP morphology',
        details: {entry_id: code, code},
      },
    ]);
    f.select('rel-2', 'rel-1');
    const hit: SearchHit = {
      source_revision_id: A,
      span_id: 'a-u1',
      coordinate_version: 'syn:unicode-scalars/1',
      native_order: 1,
      occurrence_id: 'Gen.1.1:1:6',
      form: 'בְּרֵאשִׁית',
      native_reference: {
        schema_version: 'native-reference/1',
        source_revision_id: A,
        coordinate_version: 'syn:unicode-scalars/1',
        segments: [{unit_id: 'Gen.1.1', start: 0, end: 6}],
      },
      analyses: [
        {
          analysis_id: 'analysis-' + language,
          analysis_revision_id: 'syn:tags',
          provider: 'synthetic TAHOT',
          lemma_id: lemma,
          // TAHOT's word adapter strips the H/A letter from morphology; grammar_info retains it.
          grammar: {language, morphology},
          basis: 'STEP native morphological source',
        },
      ],
    };
    const adapter = completeWordAdapter([hit]);
    const batch = await languageBatch(
      await ReadSession.open(f.env, limitsFor({}, 'aid')),
      {
        mode: 'word_study',
        depth: 'focused',
        language: 'en',
        lookup: 'lemma',
        key: lemma,
        sources: [A],
      },
      null,
      'test',
      [],
      adapter,
    );
    assert.equal(
      batch.evidence.filter(item => item.kind === 'language_aid').length,
      2,
    );
    const word = batch.evidence.find(item => item.kind === 'search_hit');
    assert.equal(word?.kind, 'search_hit');
    if (word?.kind !== 'search_hit') throw new Error('Expected word hit');
    assert.equal(word.hit.aid_matches?.[0].analysis_id, 'analysis-' + language);
    assert.equal(
      word.hit.aid_matches?.[0].lexicon.length,
      1,
      'lettered Strong resolves base lexicon',
    );
    assert.equal(
      word.hit.aid_matches?.[0].grammar.length,
      1,
      'morphology receives H/A prefix',
    );
    assert.equal(batch.continuation, null);
  });
}

function nameHit(id: string, grammar: Record<string, string> = {}): SearchHit {
  return {
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: 0,
    occurrence_id: id,
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: 0, end: 1}],
    },
    analyses: [{analysis_id: 'one', lemma_id: 'G1234G', grammar}],
  };
}

function completeWordAdapter(hits: SearchHit[]): SearchAdapter {
  return {
    async search(_session, request) {
      return {
        state: 'complete',
        lookup: request.lookup,
        key: request.key,
        hits,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: hits.map(hit => ({
          source: hit.source_revision_id,
          output: 'syn-word',
          order: hit.native_order,
          dir: 0,
          entry: 0,
          after: null,
          anchor: null,
        })),
      };
    },
  };
}

test('TIPNR lookup and word evidence retain distinct disambiguated identity candidates', async () => {
  const f = aids();
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'proper_name',
      provider: 'synthetic TIPNR',
      details: {
        disambiguated_strong: 'G1234G',
        identity: 'Alex@Mat.1.1=G1234G',
      },
    },
    {
      kind: 'proper_name',
      provider: 'synthetic TIPNR',
      details: {
        disambiguated_strong: 'G1234H',
        identity: 'Alex@Mat.2.1=G1234H',
      },
    },
  ]);
  f.select('rel-2', 'rel-1');
  const result = await study(f.env, {
    mode: 'word_study',
    search_leads: [{lookup: 'proper_name', key: 'g1234G'}],
  });
  const evidence = (result.evidence as EvidenceItem[]).filter(
    item => item.kind === 'language_aid',
  );
  assert.equal(evidence.length, 1);
  assert.equal(
    evidence[0].kind === 'language_aid' && evidence[0].details.identity,
    'Alex@Mat.1.1=G1234G',
  );
  const hit = nameHit('one');
  const adapter = completeWordAdapter([hit]);
  const batch = await languageBatch(
    await ReadSession.open(f.env, limitsFor({}, 'aid')),
    {
      mode: 'word_study',
      focus: 'names',
      depth: 'focused',
      language: 'en',
      lookup: 'word',
      key: 'a',
      sources: [A],
    },
    null,
    'test',
    [],
    adapter,
  );
  assert.equal(batch.evidence[0]?.kind, 'language_aid');
  const word = batch.evidence.find(item => item.kind === 'search_hit');
  assert.equal(
    word?.kind === 'search_hit' &&
      word.hit.aid_matches?.[0].proper_name?.length,
    1,
  );
  assert.ok(
    batch.evidence.some(
      item =>
        item.kind === 'language_aid' &&
        item.details.identity === 'Alex@Mat.1.1=G1234G',
    ),
  );
  assert.ok(
    !batch.evidence.some(
      item =>
        item.kind === 'language_aid' &&
        item.details.identity === 'Alex@Mat.2.1=G1234H',
    ),
  );
});

function linkedBudgetFixture() {
  const f = aids();
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      provider: 'lexicon',
      details: {strong_base: 'G1234', entry_id: 'lex-budget'},
    },
    {
      kind: 'grammar_expansion',
      provider: 'grammar',
      details: {code: 'N-ASN', entry_id: 'grammar-budget'},
    },
    {
      kind: 'proper_name',
      provider: 'TIPNR',
      details: {disambiguated_strong: 'G1234G', identity: 'Alex'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  const hit = nameHit('budget', {language: 'greek', morphology: 'N-ASN'});
  return {f, adapter: completeWordAdapter([hit])};
}

test('limited word searches prioritize lexical evidence and continue every outstanding kind', async () => {
  for (const used of [4, 5]) {
    const {f, adapter} = linkedBudgetFixture();
    const request = {
      mode: 'word_study',
      depth: 'focused',
      language: 'en',
      lookup: 'word',
      key: 'a',
      sources: [A],
    };
    const open = () => ReadSession.open(f.env, limitsFor({}, 'aid'));
    const session = await open();
    while (session.budget.usage().d1Calls < used) session.budget.spendQuery();
    const first = await languageBatch(
      session,
      request,
      null,
      'test',
      [],
      adapter,
    );
    const word = first.evidence.find(item => item.kind === 'search_hit');
    const matches = word?.hit.aid_matches?.[0];
    assert.ok(matches);
    assert.equal(matches.lexicon.length, 1);
    assert.equal(matches.grammar.length, used === 4 ? 1 : 0);
    assert.deepEqual(matches.proper_name, []);
    assert.ok(first.continuation);
    const rejected = await open();
    await assert.rejects(
      languageBatch(
        rejected,
        {...request, key: 'different'},
        first.continuation,
        'test',
        [],
        adapter,
      ),
      /different workload/,
    );

    let cursor: string | null = first.continuation;
    let calls = 0;
    const delivered: string[] = [];
    while (cursor) {
      const next = await languageBatch(
        await open(),
        request,
        cursor,
        'test',
        [],
        adapter,
      );
      for (const evidence of next.evidence)
        if (evidence.kind === 'language_aid')
          delivered.push(evidence.span.kind);
      if (delivered.includes('proper_name')) {
        const scope = next.delivered_scope as {
          linked_aid: unknown;
          sources: unknown;
        };
        assert.deepEqual(scope.linked_aid, {
          lookup: 'proper_name',
          key: 'G1234G',
        });
        assert.equal(scope.sources, null);
      }
      cursor = next.continuation;
      assert.ok(++calls < 5);
    }
    assert.deepEqual(
      delivered,
      used === 4 ? ['proper_name'] : ['grammar_expansion', 'proper_name'],
    );
  }
});

test('one indexed presence query screens all linked kinds against the selected release', async () => {
  const f = aids();
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'proper_name',
      provider: 'TIPNR',
      details: {disambiguated_strong: 'G3010'},
    },
  ]);
  addAids(f, 'syn-ev-old', [
    {
      kind: 'proper_name',
      provider: 'TIPNR',
      details: {disambiguated_strong: 'G3011'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  const keys: [string, string][] = Array.from({length: 20}, (_, i) => [
    'proper_name',
    'G' + (3000 + i),
  ]);
  keys.push(['lexicon_entry', 'H1234'], ['grammar_expansion', 'Ncmsa']);
  const session = await ReadSession.open(f.env, limitsFor({}, 'aid'));
  const before = session.budget.usage().d1Calls;
  const result = await session.query('linked_aid_presence', {keys});
  assert.equal(session.budget.usage().d1Calls - before, 1);
  assert.deepEqual(JSON.parse(String(result.rows[0].keys)), [
    ['proper_name', 'G3010'],
    ['lexicon_entry', 'H1234'],
    ['grammar_expansion', 'Ncmsa'],
  ]);
});

test('word budget stays within configured platform caps', () => {
  assert.equal(limitsFor({}, 'word').d1Calls, 8);
  assert.equal(limitsFor({MAX_D1_CALLS: 6}, 'word').d1Calls, 6);
  assert.equal(limitsFor({MAX_D1_CALLS: 7}, 'word').d1Calls, 7);
});

test('Study follows a full name tag through to its indexed occurrences', async () => {
  const f = buildFixture({strongLemmas: {beta: 'G2264G', theta: 'G2264H'}});
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'proper_name',
      provider: 'synthetic TIPNR',
      details: {disambiguated_strong: 'G2264G', identity: 'Herod'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  const request = {
    mode: 'word_study',
    search_leads: [{lookup: 'proper_name', key: 'G2264G'}],
  } as const;
  const input = {...request, search_leads: [...request.search_leads]};
  const first = await study(f.env, input);
  assert.ok(
    (first.evidence as EvidenceItem[]).some(
      item => item.kind === 'language_aid',
    ),
  );
  assert.equal(typeof first.continuation, 'string');
  const resumed = await study(f.env, {
    ...input,
    continuation: String(first.continuation),
  });
  const hits = (resumed.evidence as EvidenceItem[]).flatMap(item =>
    item.kind === 'search_hit' ? [item.hit] : [],
  );
  assert.deepEqual(
    hits.map(hit => hit.form),
    ['beta'],
  );
  const differentFocus = await study(f.env, {
    ...input,
    focus: 'occurrences',
    continuation: String(first.continuation),
  });
  assert.equal(
    (differentFocus.limitations as Array<{state: string}>)[0].state,
    'invalid_request',
  );
  const occurrencesFirst = await study(f.env, {...input, focus: 'occurrences'});
  assert.equal(
    (occurrencesFirst.evidence as EvidenceItem[])[0].kind,
    'search_hit',
  );
});
