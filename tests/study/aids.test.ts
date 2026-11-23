import assert from 'node:assert/strict';
import {test} from 'node:test';
import {A, buildFixture} from './fixture.ts';
import {addAids, aidKey} from './aid-fixture.ts';
import {ReadSession} from '../../services/study/src/read/session.ts';
import {
  AID_LIMITS,
  STARTING_LIMITS,
  WORD_LIMITS,
  limitsFor,
} from '../../services/study/src/read/budget.ts';
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
  const limits = {...STARTING_LIMITS, rowsPerQuery: 1};
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
  // Shared verified text is visible to a new Worker instance with an empty local WeakMap.
  const shared = new Map<string, string>();
  let kvReads = 0,
    kvWrites = 0;
  const withCache = {
    ...f.env,
    VERIFIED_WORD_CACHE: {
      get: async (key: string) => {
        kvReads++;
        return shared.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        kvWrites++;
        shared.set(key, value);
      },
    },
  };
  const freshInstance = () => ({
    ...withCache,
    PRIVATE_OBJECTS: {
      get: (key: string, options?: {range: {offset: number; length: number}}) =>
        f.bucket.get(key, options),
    },
  });
  let next: string | null = null;
  const chunks: string[] = [];
  let expectedStart = -1; // The entry starts where it lies in its partition's native text.
  let firstReadCount = 0;
  for (let i = 0; i < 10; i++) {
    const result = await aidBatch(
      await ReadSession.open(i ? freshInstance() : withCache, AID_LIMITS),
      {...workload, key: 'G1234'},
      next,
      'test',
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(result)) <= STARTING_LIMITS.resultBytes,
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
    const longReads = f.bucket.reads.filter(
      read => read.key === aidKey('syn-ev'),
    ).length;
    if (i === 0) {
      firstReadCount = longReads;
      assert.ok(
        firstReadCount > 1,
        'the first part reads and verifies the source range',
      );
    } else {
      assert.equal(
        longReads,
        firstReadCount,
        'cross-instance continuation reuses digest-checked KV wording',
      );
    }
    next = result.continuation;
    if (!next) break;
  }
  assert.equal(next, null);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), body);
  assert.ok(
    kvReads > 0 && kvWrites > 0,
    'enabled by default: KV was read and written',
  );
  assert.equal(
    JSON.parse([...shared.values()][0]).text,
    body,
    'KV stores only the digest-checked entry line',
  );
  const routed = await study(f.env, {
    mode: 'word_study',
    search_leads: [{lookup: 'lexicon', key: 'G1234'}],
  });
  assert.equal((routed.evidence as unknown[]).length, 1);
  assert.ok(
    routed.continuation,
    'Study selects the larger bounded allowance for language-aid retrieval',
  );
  const pending = await aidBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {...workload, key: 'G1234'},
    null,
    'test',
  );
  assert.ok(pending.continuation);
  f.select('rel-1', 'rel-2');
  await assert.rejects(
    aidBatch(
      await ReadSession.open(f.env, AID_LIMITS),
      {...workload, key: 'G1234'},
      pending.continuation,
      'test',
    ),
    /Continuation entry is no longer selected/,
  );
  f.select('rel-2', 'rel-1');
  const beforeReselection = f.bucket.reads.filter(
    read => read.key === aidKey('syn-ev'),
  ).length;
  await aidBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {...workload, key: 'G1234'},
    null,
    'test',
  );
  assert.ok(
    f.bucket.reads.filter(read => read.key === aidKey('syn-ev')).length >
      beforeReselection,
    'reselected source is verified again after a release change',
  );
  // Free-plan switch: even with a KV binding, perform no KV get/put at all.
  // A new R2 binding on each call simulates separate Workers without local cache.
  const beforeOffKv = [kvReads, kvWrites];
  const beforeOffR2 = f.bucket.reads.filter(
    read => read.key === aidKey('syn-ev'),
  ).length;
  const disabledEnv = () => ({
    ...withCache,
    AID_KV_CACHE_ENABLED: false,
    PRIVATE_OBJECTS: {
      get: (key: string, options?: {range: {offset: number; length: number}}) =>
        f.bucket.get(key, options),
    },
  });
  const offFirst = await aidBatch(
    await ReadSession.open(disabledEnv(), AID_LIMITS),
    {...workload, key: 'G1234'},
    null,
    'test',
  );
  assert.ok(offFirst.continuation);
  const offSecond = await aidBatch(
    await ReadSession.open(disabledEnv(), AID_LIMITS),
    {...workload, key: 'G1234'},
    offFirst.continuation,
    'test',
  );
  assert.ok(offSecond.evidence.some(item => item.kind === 'language_aid'));
  assert.deepEqual(
    [kvReads, kvWrites],
    beforeOffKv,
    'off means zero KV operations',
  );
  assert.ok(
    f.bucket.reads.filter(read => read.key === aidKey('syn-ev')).length >
      beforeOffR2,
    'off uses normal verified R2 reads',
  );
  assert.ok(
    !offSecond.limitations.some(item => /cache|kv/i.test(item.detail)),
    'the absence of KV is never a user-visible error',
  );

  f.bucket.corrupt.add(aidKey('syn-ev'));
  const corrupt = await aidBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {...workload, key: 'G1234'},
    null,
    'test',
  );
  assert.equal(corrupt.evidence.length, 0);
  assert.ok(corrupt.limitations.some(item => item.state === 'corrupt'));
});

test('Matthew 1 onoma (G3686) word-study attaches attributed lexicon and grammar once for repeated occurrences', async () => {
  const f = aids();
  f.select(null, null);
  addAids(f, 'syn-ev', [
    {
      kind: 'lexicon_entry',
      provider: 'synthetic Greek lexicon',
      details: {entry_id: 'G3686', strong_base: 'G3686', entry_key: 'onoma'},
    },
    {
      kind: 'grammar_expansion',
      provider: 'synthetic Greek morphology',
      details: {code: 'N-ASN', entry_id: 'N-ASN'},
    },
  ]);
  f.select('rel-2', 'rel-1');

  const positions = ['Mat.1.21', 'Mat.1.23', 'Mat.1.25'];
  const hits: SearchHit[] = positions.map((unit, i) => ({
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: i,
    occurrence_id: unit + ':33:38',
    form: 'ὄνομα',
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: unit, start: 33, end: 38}],
    },
    analyses: [
      {
        analysis_id: unit + ':1',
        analysis_revision_id: 'syn:tags',
        provider: 'synthetic TAGNT',
        lemma_id: 'G3686',
        grammar: {language: 'greek', morphology: 'N-ASN'},
        basis: 'TAGNT dStrong=Grammar',
      },
    ],
  }));
  const adapter: SearchAdapter = {
    async search() {
      return {
        state: 'complete',
        lookup: 'lemma',
        key: 'G3686',
        hits,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false as const,
        resume_after: hits.map((hit, i) => ({
          source: A,
          output: 'syn-word',
          order: i,
          dir: 0,
          entry: 0,
          after: null,
          anchor: null,
        })),
      };
    },
  };
  const prepare = f.db.prepare.bind(f.db);
  let lexCalls = 0,
    gramCalls = 0;
  f.db.prepare = sql => {
    if (sql.includes("e.kind = 'lexicon_entry'")) lexCalls++;
    if (sql.includes("e.kind = 'grammar_expansion'")) gramCalls++;
    return prepare(sql);
  };
  const session = await ReadSession.open(f.env, AID_LIMITS);
  const batch = await languageBatch(
    session,
    {
      mode: 'word_study',
      depth: 'focused',
      language: 'en',
      lookup: 'lemma',
      key: 'G3686',
      sources: [A],
    },
    null,
    'test',
    [],
    adapter,
  );
  const attached = batch.evidence.filter(item => item.kind === 'language_aid');
  assert.equal(
    attached.length,
    2,
    'lexicon and morphology evidence included once, not once per occurrence',
  );
  assert.deepEqual(
    attached.map(item => (item.kind === 'language_aid' ? item.provider : '')),
    ['synthetic Greek lexicon', 'synthetic Greek morphology'],
  );
  assert.equal(lexCalls, 1);
  assert.equal(gramCalls, 1);
  for (const hit of batch.evidence.filter(item => item.kind === 'search_hit')) {
    if (hit.kind !== 'search_hit') continue;
    assert.equal(hit.hit.aid_matches?.[0].lexicon.length, 1);
    assert.equal(hit.hit.aid_matches?.[0].grammar.length, 1);
  }
  assert.equal(batch.continuation, null);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= AID_LIMITS.resultBytes);
  assert.ok(session.budget.usage().d1Calls <= AID_LIMITS.d1Calls);
  assert.ok(session.budget.usage().r2Reads <= AID_LIMITS.r2Reads);
  const standalone = await study(f.env, {
    mode: 'word_study',
    search_leads: [{lookup: 'lexicon', key: 'G3686'}],
  });
  assert.ok(
    (standalone.evidence as Array<{kind: string}>).some(
      item => item.kind === 'language_aid',
    ),
  );
  // One study can span multiple bounded calls. The complete, selected aid entries
  // are reused rather than queried and verified again.
  const next = await languageBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {
      mode: 'word_study',
      depth: 'focused',
      language: 'en',
      lookup: 'lemma',
      key: 'G3686',
      sources: [A],
    },
    null,
    'test',
    [],
    adapter,
  );
  assert.equal(lexCalls, 1, 'cached lexicon not queried again');
  assert.equal(gramCalls, 1, 'cached grammar not queried again');
  assert.equal(
    next.evidence.filter(item => item.kind === 'language_aid').length,
    2,
  );
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
    const adapter: SearchAdapter = {
      async search() {
        return {
          state: 'complete',
          lookup: 'lemma',
          key: lemma,
          hits: [hit],
          searched: [],
          limitations: [],
          remaining: null,
          ranked: false as const,
          resume_after: [
            {
              source: A,
              output: 'syn-word',
              order: 1,
              dir: 0,
              entry: 0,
              after: null,
              anchor: null,
            },
          ],
        };
      },
    };
    const batch = await languageBatch(
      await ReadSession.open(f.env, AID_LIMITS),
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
  const hit: SearchHit = {
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: 0,
    occurrence_id: 'one',
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: 0, end: 1}],
    },
    analyses: [{analysis_id: 'one', lemma_id: 'G1234G', grammar: {}}],
  };
  const adapter: SearchAdapter = {
    async search() {
      return {
        state: 'complete',
        lookup: 'word',
        key: 'a',
        hits: [hit],
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: [
          {
            source: A,
            output: 'syn-word',
            order: 0,
            dir: 0,
            entry: 0,
            after: null,
            anchor: null,
          },
        ],
      };
    },
  };
  const batch = await languageBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {
      mode: 'word_study',
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

test('TIPNR candidates use only budget remaining after all lexical and grammar keys', async () => {
  for (const used of [3, 4]) {
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
    const hit: SearchHit = {
      source_revision_id: A,
      span_id: 'a-u1',
      coordinate_version: 'syn:unicode-scalars/1',
      native_order: 0,
      occurrence_id: 'budget',
      native_reference: {
        schema_version: 'native-reference/1',
        source_revision_id: A,
        coordinate_version: 'syn:unicode-scalars/1',
        segments: [{unit_id: 'Mat.1.1', start: 0, end: 1}],
      },
      analyses: [
        {
          analysis_id: 'one',
          lemma_id: 'G1234G',
          grammar: {language: 'greek', morphology: 'N-ASN'},
        },
      ],
    };
    const adapter: SearchAdapter = {
      async search() {
        return {
          state: 'complete',
          lookup: 'word',
          key: 'a',
          hits: [hit],
          searched: [],
          limitations: [],
          remaining: null,
          ranked: false,
          resume_after: [
            {
              source: A,
              output: 'syn-word',
              order: 0,
              dir: 0,
              entry: 0,
              after: null,
              anchor: null,
            },
          ],
        };
      },
    };
    const session = await ReadSession.open(f.env, AID_LIMITS);
    while (session.budget.usage().d1Calls < used) session.budget.spendQuery();
    const batch = await languageBatch(
      session,
      {
        mode: 'word_study',
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
    const word = batch.evidence.find(item => item.kind === 'search_hit');
    assert.equal(
      word?.kind === 'search_hit' && word.hit.aid_matches?.[0].lexicon.length,
      1,
    );
    assert.equal(
      word?.kind === 'search_hit' && word.hit.aid_matches?.[0].grammar.length,
      used === 3 ? 1 : 0,
    );
    assert.equal(
      word?.kind === 'search_hit' &&
        word.hit.aid_matches?.[0].proper_name?.length,
      0,
    );
  }
});

test('name evidence continues automatically when word-search budget is exhausted', async () => {
  for (const used of [3]) {
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
    const hit: SearchHit = {
      source_revision_id: A,
      span_id: 'a-u1',
      coordinate_version: 'syn:unicode-scalars/1',
      native_order: 0,
      occurrence_id: 'budget',
      native_reference: {
        schema_version: 'native-reference/1',
        source_revision_id: A,
        coordinate_version: 'syn:unicode-scalars/1',
        segments: [{unit_id: 'Mat.1.1', start: 0, end: 1}],
      },
      analyses: [
        {
          analysis_id: 'one',
          lemma_id: 'G1234G',
          grammar: {language: 'greek', morphology: 'N-ASN'},
        },
      ],
    };
    const adapter: SearchAdapter = {
      async search() {
        return {
          state: 'complete',
          lookup: 'word',
          key: 'a',
          hits: [hit],
          searched: [],
          limitations: [],
          remaining: null,
          ranked: false,
          resume_after: [
            {
              source: A,
              output: 'syn-word',
              order: 0,
              dir: 0,
              entry: 0,
              after: null,
              anchor: null,
            },
          ],
        };
      },
    };
    const session = await ReadSession.open(f.env, AID_LIMITS);
    while (session.budget.usage().d1Calls < used) session.budget.spendQuery();
    const batch = await languageBatch(
      session,
      {
        mode: 'word_study',
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
    const word = batch.evidence.find(item => item.kind === 'search_hit');
    assert.equal(
      word?.kind === 'search_hit' && word.hit.aid_matches?.[0].lexicon.length,
      1,
    );
    assert.equal(
      word?.kind === 'search_hit' && word.hit.aid_matches?.[0].grammar.length,
      used === 3 ? 1 : 0,
    );
    assert.ok(
      batch.continuation,
      'name evidence must have a continuation when the budget is exhausted',
    );
    await assert.rejects(
      languageBatch(
        await ReadSession.open(f.env, AID_LIMITS),
        {
          mode: 'word_study',
          depth: 'focused',
          language: 'en',
          lookup: 'word',
          key: 'different',
          sources: [A],
        },
        batch.continuation,
        'test',
        [],
        adapter,
      ),
    );
    let token: string | null = batch.continuation;
    let found = false,
      calls = 0;
    while (token) {
      const followed = await languageBatch(
        await ReadSession.open(f.env, AID_LIMITS),
        {
          mode: 'word_study',
          depth: 'focused',
          language: 'en',
          lookup: 'word',
          key: 'a',
          sources: [A],
        },
        token,
        'test',
        [],
        adapter,
      );
      if (
        followed.evidence.some(
          e => e.kind === 'language_aid' && e.details.identity === 'Alex',
        )
      ) {
        assert.equal(
          (followed.delivered_scope as {proper_name_for: string})
            .proper_name_for,
          'G1234G',
        );
        assert.equal(
          (followed.delivered_scope as {sources: unknown}).sources,
          null,
        );
        found = true;
      }
      token = followed.continuation;
      assert.ok(++calls < 5);
    }
    assert.ok(found, 'name evidence arrives automatically');
  }
});

test('name continuations finish before the next page of word results', async () => {
  const f = aids();
  const hits: SearchHit[] = Array.from({length: 5}, (_, i) => ({
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: i,
    occurrence_id: 'word-' + i,
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: i, end: i + 1}],
    },
    analyses: [
      {analysis_id: 'analysis-' + i, lemma_id: 'G123' + i + 'G', grammar: {}},
    ],
  }));
  const position = (i: number) => ({
    source: A,
    output: 'syn-word',
    order: i,
    dir: 0,
    entry: 0,
    after: [i, 'word-' + i] as [number, string],
    anchor: {file: 'page', offset: 0, length: 1, sha256: 'a'.repeat(64)},
  });
  const adapter: SearchAdapter = {
    async search(_session, request) {
      const first = request.position?.after ? request.position.after[0] + 1 : 0;
      const selected = hits.slice(first);
      return {
        state: 'complete',
        lookup: 'word',
        key: 'a',
        hits: selected,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: selected.map((_, i) => position(first + i)),
      };
    },
  };
  const workload = {
    mode: 'word_study',
    depth: 'focused',
    language: 'en',
    lookup: 'word',
    key: 'a',
    sources: [A],
  };
  let token: string | null = null;
  const seen: string[] = [];
  let calls = 0;
  do {
    const batch = await languageBatch(
      await ReadSession.open(f.env, AID_LIMITS),
      workload,
      token,
      'test',
      [],
      adapter,
    );
    seen.push(
      ...batch.evidence.flatMap(e =>
        e.kind === 'search_hit' ? [e.hit.occurrence_id] : [],
      ),
    );
    token = batch.continuation;
    assert.ok(++calls < 15, 'continuations must make progress');
  } while (token);
  assert.deepEqual(seen, ['word-0', 'word-1', 'word-2', 'word-3', 'word-4']);
});

test('continued name evidence delivers a long entry without losing wording', async () => {
  const f = aids();
  f.select(null, null);
  const body = 'Long name entry α '.repeat(2000);
  addAids(f, 'syn-ev', [
    {
      kind: 'proper_name',
      provider: 'TIPNR',
      text: body,
      details: {disambiguated_strong: 'G1234G'},
    },
  ]);
  f.select('rel-2', 'rel-1');
  const hit: SearchHit = {
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: 0,
    occurrence_id: 'word',
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: 0, end: 1}],
    },
    analyses: [{analysis_id: 'one', lemma_id: 'G1234G', grammar: {}}],
  };
  const adapter: SearchAdapter = {
    async search() {
      return {
        state: 'complete',
        lookup: 'word',
        key: 'a',
        hits: [hit],
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: [
          {
            source: A,
            output: 'syn-word',
            order: 0,
            dir: 0,
            entry: 0,
            after: null,
            anchor: null,
          },
        ],
      };
    },
  };
  const workload = {
    mode: 'word_study',
    depth: 'focused',
    language: 'en',
    lookup: 'word',
    key: 'a',
    sources: [A],
  };
  const initial = await ReadSession.open(f.env, AID_LIMITS);
  while (initial.budget.usage().d1Calls < 4) initial.budget.spendQuery();
  let batch = await languageBatch(initial, workload, null, 'test', [], adapter);
  let text = '',
    calls = 0;
  while (batch.continuation) {
    batch = await languageBatch(
      await ReadSession.open(f.env, AID_LIMITS),
      workload,
      batch.continuation,
      'test',
      [],
      adapter,
    );
    for (const item of batch.evidence)
      if (item.kind === 'language_aid') text += item.span.text?.join('') ?? '';
    assert.ok(++calls < 10);
  }
  assert.equal(text, body);
});

test('twenty distinct non-name lemmas remain one full word-search batch', async () => {
  const f = aids();
  const hits: SearchHit[] = Array.from({length: 20}, (_, i) => ({
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: i,
    occurrence_id: 'nonname-' + i,
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: i, end: i + 1}],
    },
    analyses: [
      {
        analysis_id: 'analysis-' + i,
        lemma_id: 'G' + String(3000 + i),
        grammar: {},
      },
    ],
  }));
  const adapter: SearchAdapter = {
    async search(session) {
      while (session.budget.usage().d1Calls < 2) session.budget.spendQuery();
      return {
        state: 'complete',
        lookup: 'grammar',
        key: 'greek:N-NSM',
        hits,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: hits.map((_, i) => ({
          source: A,
          output: 'syn-word',
          order: i,
          dir: 0,
          entry: 0,
          after: null,
          anchor: null,
        })),
      };
    },
  };
  const batch = await languageBatch(
    await ReadSession.open(f.env, AID_LIMITS),
    {
      mode: 'word_study',
      depth: 'focused',
      language: 'en',
      lookup: 'grammar',
      key: 'greek:N-NSM',
      sources: [A],
    },
    null,
    'test',
    [],
    adapter,
  );
  assert.equal(batch.evidence.filter(e => e.kind === 'search_hit').length, 20);
  assert.equal(
    batch.continuation,
    null,
    'non-names must not produce empty follow-up batches',
  );
});

test('name presence scans many tags in one selected-release query', async () => {
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
  const tags = Array.from({length: 20}, (_, i) => 'G' + (3000 + i));
  const session = await ReadSession.open(f.env, AID_LIMITS);
  const before = session.budget.usage().d1Calls;
  const result = await session.query('proper_name_presence', {tags});
  assert.equal(session.budget.usage().d1Calls - before, 1);
  assert.deepEqual(JSON.parse(String(result.rows[0].tags)), ['G3010']);
  f.db.sqlite.exec('DROP INDEX aid_entries_lookup');
  const withoutIndex = await ReadSession.open(
    {...f.env, DATA_DB: f.db},
    AID_LIMITS,
  );
  const unindexed = await withoutIndex.query('proper_name_presence', {
    tags: ['G3010', 'G3011'],
  });
  assert.deepEqual(JSON.parse(String(unindexed.rows[0].tags)), ['G3010']);
});

test('four-query word search does not create an empty name batch', async () => {
  const f = aids();
  const hits: SearchHit[] = Array.from({length: 20}, (_, i) => ({
    source_revision_id: A,
    span_id: 'a-u1',
    coordinate_version: 'syn:unicode-scalars/1',
    native_order: i,
    occurrence_id: 'nonname-' + i,
    native_reference: {
      schema_version: 'native-reference/1',
      source_revision_id: A,
      coordinate_version: 'syn:unicode-scalars/1',
      segments: [{unit_id: 'Mat.1.1', start: i, end: i + 1}],
    },
    analyses: [
      {
        analysis_id: 'analysis-' + i,
        lemma_id: 'G' + String(3000 + i),
        grammar: {},
      },
    ],
  }));
  const adapter: SearchAdapter = {
    async search(session) {
      while (session.budget.usage().d1Calls < 4) session.budget.spendQuery();
      return {
        state: 'complete',
        lookup: 'grammar',
        key: 'greek:N-NSM',
        hits,
        searched: [],
        limitations: [],
        remaining: null,
        ranked: false,
        resume_after: hits.map((_, i) => ({
          source: A,
          output: 'syn-word',
          order: i,
          dir: 0,
          entry: 0,
          after: null,
          anchor: null,
        })),
      };
    },
  };
  const batch = await languageBatch(
    await ReadSession.open(f.env, WORD_LIMITS),
    {
      mode: 'word_study',
      depth: 'focused',
      language: 'en',
      lookup: 'grammar',
      key: 'greek:N-NSM',
      sources: [A],
    },
    null,
    'test',
    [],
    adapter,
  );
  assert.equal(batch.evidence.filter(e => e.kind === 'search_hit').length, 20);
  assert.equal(
    batch.continuation,
    null,
    'non-names must not produce empty follow-up batches',
  );
});

test('word budget stays within configured platform caps', () => {
  assert.equal(limitsFor({}, WORD_LIMITS).d1Calls, 8);
  assert.equal(limitsFor({MAX_D1_CALLS: 6}, WORD_LIMITS).d1Calls, 6);
  assert.equal(limitsFor({MAX_D1_CALLS: 7}, WORD_LIMITS).d1Calls, 7);
});
