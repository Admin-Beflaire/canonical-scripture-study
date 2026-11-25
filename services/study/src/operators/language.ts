import {compareUtf8, isIdentifier, utf8Length} from '../read/bytes.ts';
import {
  PagedIndexSearch,
  SUPPORTED_LOOKUPS,
  UNSUPPORTED_LOOKUPS,
  type LookupKind,
  type SearchAdapter,
  type SearchHit,
} from '../read/search.ts';
import type {ReadSession} from '../read/session.ts';
import {ReadError, type Limitation} from '../read/states.ts';
import type {Batch, EvidenceItem} from '../results/batch.ts';
import {
  searchBatch,
  normalizeSearchWorkload,
  SEARCH_CHECKS,
  type SearchWorkload,
} from '../results/search-batch.ts';
import {
  encodeContinuation,
  resumeContinuation,
} from '../results/continuation.ts';
import {aidBatch, type AidLookup} from './aids.ts';
import {normalizeKey} from '../scope/keys.ts';

/** Capability each lookup needs from a selected index. */
const CAPABILITY: Record<string, string> = {
  word: 'word_exact',
  form: 'form_exact',
  lemma: 'lemma_exact',
  grammar: 'grammar_exact',
};
/** The capabilities the release summary holds: those of the search indexes. */
const INDEX_CAPABILITIES = new Set(Object.values(CAPABILITY));

export interface LanguageWorkload {
  mode: string;
  depth: string;
  language: string;
  lookup: string;
  key: string;
  sources: string[] | null;
  focus?: EvidenceFocus;
}

export const EVIDENCE_FOCUS = [
  'lexicon',
  'grammar',
  'names',
  'occurrences',
] as const;
export type EvidenceFocus = (typeof EVIDENCE_FOCUS)[number];
type LinkedLookup = Exclude<AidLookup, 'lexicon_entry'>;
type LinkedKey = [LinkedLookup, string];
type LinkedState = {
  keys: LinkedKey[];
  aid: string | null;
  search: string | null;
  check: boolean;
};
const MAX_LINKED_STATE_BYTES = 560;
const LINKED_KIND: Record<LinkedLookup, string> = {
  lexicon: 'lexicon_entry',
  grammar_info: 'grammar_expansion',
  proper_name: 'proper_name',
};
const LINKED_FOCUS: Record<LinkedLookup, EvidenceFocus> = {
  lexicon: 'lexicon',
  grammar_info: 'grammar',
  proper_name: 'names',
};
const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const identity = (lookup: LinkedLookup, key: string) => lookup + ':' + key;
const tokenOrNull = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && /^[\w-]{1,2048}$/.test(value));

function fitsLinkedState(keys: LinkedKey[]) {
  return utf8Length(JSON.stringify(keys)) <= MAX_LINKED_STATE_BYTES;
}

function linkedState(pos: unknown, key: unknown) {
  if (
    key !== null ||
    !isObject(pos) ||
    Object.keys(pos).sort().join(',') !== 'aid,check,keys,search' ||
    !Array.isArray(pos.keys) ||
    !pos.keys.length ||
    !fitsLinkedState(pos.keys) ||
    !tokenOrNull(pos.aid) ||
    !tokenOrNull(pos.search) ||
    typeof pos.check !== 'boolean' ||
    (pos.check && pos.aid !== null)
  )
    return false;
  return pos.keys.every(
    item =>
      Array.isArray(item) &&
      item.length === 2 &&
      Object.hasOwn(LINKED_KIND, item[0]) &&
      isIdentifier(item[1], 200),
  );
}

/** Most sources one search covers (the search interface's own limit). */
export const MAX_SEARCH_SOURCES = 20;

/** The selected sources offering a capability, in a stable order. More than one search can
 *  cover is refused with a clear request to name sources, never silently narrowed. */
export async function sourcesWith(
  session: ReadSession,
  capability: string,
): Promise<string[]> {
  const sources = new Set<string>();
  let after: [string, string] | null = null;
  for (;;) {
    const {rows, more}: {rows: Record<string, unknown>[]; more: boolean} =
      await session.query(
        session.release.index_summary && INDEX_CAPABILITIES.has(capability)
          ? 'release_sources_summary'
          : 'release_sources',
        {capability, after},
      );
    for (const row of rows)
      if (Number(row.available) > 0)
        sources.add(String(row.source_revision_id));
    if (sources.size > MAX_SEARCH_SOURCES)
      throw new ReadError(
        'invalid_request',
        `More than ${MAX_SEARCH_SOURCES} selected sources offer this search; name up to ${MAX_SEARCH_SOURCES} in sources`,
      );
    if (!more || !rows.length) break;
    after = [
      String(rows.at(-1)!.source_revision_id),
      String(rows.at(-1)!.capability),
    ];
  }
  return [...sources].sort(compareUtf8);
}

/** Exact word, form, lemma or grammar occurrences through the read search interface. Keys typed
 *  by the host are normalized with their script's rule; the batch states what was searched. */
export async function languageBatch(
  session: ReadSession,
  workload: LanguageWorkload,
  continuation: string | null,
  guidanceVersion: string,
  notes: Limitation[] = [],
  adapter: SearchAdapter = new PagedIndexSearch(),
): Promise<Batch> {
  const lookup = workload.lookup;
  if (
    ![...SUPPORTED_LOOKUPS, ...UNSUPPORTED_LOOKUPS].includes(
      lookup as LookupKind,
    )
  )
    throw new ReadError(
      'invalid_request',
      `Unknown lookup "${lookup}"; use word, form, lemma or grammar`,
    );
  if (typeof workload.key !== 'string' || !workload.key.trim())
    throw new ReadError('invalid_request', 'A search lead needs a key');
  let sources = workload.sources;
  if (
    sources != null &&
    (!Array.isArray(sources) ||
      !sources.length ||
      !sources.every(s => isIdentifier(s)))
  )
    throw new ReadError(
      'invalid_request',
      'Sources are source revision IDs as listed by the study tool',
    );
  if (sources == null) {
    sources = UNSUPPORTED_LOOKUPS.includes(lookup as LookupKind)
      ? ['none']
      : await sourcesWith(session, CAPABILITY[lookup]);
    if (!sources.length)
      throw new ReadError(
        'missing_index',
        `No selected source offers ${lookup} search`,
      );
  }
  const normalized = normalizeSearchWorkload({
    mode: workload.mode,
    depth: workload.depth,
    language: workload.language,
    lookup,
    key: normalizeKey(lookup, workload.key),
    sources,
    focus: workload.focus,
  });
  if (!SUPPORTED_LOOKUPS.includes(lookup as LookupKind))
    return searchBatch(
      session,
      adapter,
      normalized,
      continuation,
      guidanceVersion,
      notes,
    );
  return linkedLanguageBatch(
    session,
    adapter,
    normalized,
    continuation,
    guidanceVersion,
    notes,
  );
}

async function linkedLanguageBatch(
  session: ReadSession,
  adapter: SearchAdapter,
  workload: SearchWorkload,
  continuation: string | null,
  guidance: string,
  notes: Limitation[],
) {
  let search = continuation;
  if (continuation) {
    const state = await resumeContinuation(continuation, workload, {
      ...SEARCH_CHECKS,
      linked_aids: linkedState,
    });
    if (state.op === 'linked_aids') {
      const pending = state.pos as LinkedState;
      if (pending.check) {
        pending.keys =
          (await selectedLinkedKeys(session, pending.keys)) ?? pending.keys;
        pending.check = false;
      }
      if (pending.keys.length)
        return continueLinkedAids(session, workload, pending, guidance);
      if (!pending.search)
        return exhaustedLinkedPage(session, workload, guidance);
      search = pending.search;
    }
  }
  return searchLinkedPage(session, adapter, workload, search, guidance, notes);
}

function exhaustedLinkedPage(
  session: ReadSession,
  workload: SearchWorkload,
  guidance: string,
): Batch {
  return {
    release_id: session.release.id,
    mode: workload.mode,
    depth: workload.depth,
    delivered_scope: {
      lookup: workload.lookup,
      key: workload.key,
      sources: workload.sources,
    },
    context_scope: null,
    evidence: [],
    citations: [],
    searched_scope: [],
    coverage: [],
    limitations: [],
    remaining: null,
    continuation: null,
    guidance_version: guidance,
  };
}

async function selectedLinkedKeys(
  session: ReadSession,
  keys: LinkedKey[],
): Promise<LinkedKey[] | null> {
  if (!keys.length) return keys;
  const result = await session.queryIfAvailable('linked_aid_presence', {
    keys: keys.map(([lookup, key]) => [LINKED_KIND[lookup], key]),
  });
  if (!result) return null;
  try {
    const value: unknown = JSON.parse(String(result.rows[0]?.keys));
    if (!Array.isArray(value)) throw new Error();
    const found = new Set(value.map(key => JSON.stringify(key)));
    return keys.filter(([lookup, key]) =>
      found.has(JSON.stringify([LINKED_KIND[lookup], key])),
    );
  } catch {
    throw new ReadError(
      'corrupt',
      'Unreadable linked-evidence presence result',
    );
  }
}

async function searchLinkedPage(
  session: ReadSession,
  adapter: SearchAdapter,
  workload: SearchWorkload,
  search: string | null,
  guidance: string,
  notes: Limitation[],
) {
  let available: Set<string> | null = null;
  let pending: LinkedState | undefined;
  // A cold occurrence lookup can spend the full R2 allowance. Leave two reads
  // for its first lexical and grammar entries when evidence has priority.
  const reserve =
    !search &&
    workload.focus !== 'occurrences' &&
    session.budget.limits.r2Reads >= 8
      ? 2
      : 0;
  const batch = await session.budget.reserveR2Reads(reserve, () =>
    searchBatch(session, adapter, workload, search, guidance, notes, {
      async countHits(hits) {
        const candidates = collectKeys(hits);
        const present = session.budget.canQuery(4)
          ? await selectedLinkedKeys(session, candidates)
          : null;
        available = present && new Set(present.map(key => identity(...key)));
        return boundedHits(hits, available);
      },
      async finalize(candidate) {
        const keys = orderedKeys(pageHits(candidate), workload, available);
        pending = keys.length
          ? {keys, aid: null, search: candidate.continuation, check: !available}
          : undefined;
        if (pending) await setLinkedContinuation(candidate, workload, pending);
      },
    }),
  );
  if (!pending) return batch;
  const hits = pageHits(batch);
  const delivered = await attachLinkedAids(
    session,
    batch,
    workload,
    pending,
    guidance,
  );
  linkAnalyses(batch, hits, delivered, session.budget.limits.resultBytes);
  orderEvidence(batch, workload);
  return batch;
}

async function setLinkedContinuation(
  batch: Batch,
  workload: SearchWorkload,
  pending: LinkedState,
) {
  batch.continuation = pending.keys.length
    ? await encodeContinuation(workload, {
        op: 'linked_aids',
        pos: pending,
        key: null,
      })
    : pending.search;
  batch.remaining = batch.continuation
    ? {linked_aids: pending.keys.length, search: !!pending.search}
    : null;
}

async function continueLinkedAids(
  session: ReadSession,
  workload: SearchWorkload,
  pending: LinkedState,
  guidance: string,
) {
  const [lookup, key] = pending.keys[0];
  return aidBatch(
    session,
    {...workload, lookup, key, sources: null},
    pending.aid,
    guidance,
    [],
    {
      async finalize(batch) {
        batch.limitations = batch.limitations.filter(
          item => !(item.state === 'missing_evidence' && item.scope === key),
        );
        batch.delivered_scope = {
          lookup: workload.lookup,
          key: workload.key,
          word_sources: workload.sources,
          linked_aid: {lookup, key},
          sources: null,
        };
        const aid = batch.continuation;
        await setLinkedContinuation(batch, workload, {
          ...pending,
          aid,
          keys: aid ? pending.keys : pending.keys.slice(1),
        });
      },
    },
  );
}

interface AnalysisKeys {
  analysis_id: string;
  lexicon: string | null;
  grammar: string[];
  proper_name: string | null;
}
function wordKeys(hit: SearchHit): AnalysisKeys[] {
  if (!Array.isArray(hit.analyses)) return [];
  return hit.analyses.filter(isObject).map(a => {
    // Source analyses may have a disambiguating trailing letter (e.g. H7225G).
    // Language-aid lexicon rows are indexed by the base Strong number.
    const strong =
      typeof a.lemma_id === 'string'
        ? a.lemma_id.match(/^([HG])(\d{1,5})[A-Z]?$/i)
        : null;
    const fullTag =
      typeof a.lemma_id === 'string'
        ? a.lemma_id.match(/^([HG])(\d{1,5})([A-Z]?)$/i)
        : null;
    const proper_name = fullTag
      ? fullTag[1].toUpperCase() + fullTag[2].padStart(4, '0') + fullTag[3]
      : null;
    const lemma = strong
      ? strong[1].toUpperCase() + strong[2].padStart(4, '0')
      : null;
    const sourceGrammar = isObject(a.grammar) ? a.grammar : null;
    const morphology =
      typeof sourceGrammar?.morphology === 'string'
        ? sourceGrammar.morphology
        : '';
    const prefix =
      sourceGrammar?.language === 'hebrew'
        ? 'H'
        : sourceGrammar?.language === 'aramaic'
          ? 'A'
          : '';
    const grammar = morphology
      .split('/')
      .map(part => (prefix && part ? prefix + part : part))
      .filter(x => isIdentifier(x, 200));
    return {
      analysis_id: typeof a.analysis_id === 'string' ? a.analysis_id : '',
      lexicon: lemma,
      grammar,
      proper_name,
    };
  });
}

function pageHits(batch: Batch): SearchHit[] {
  return batch.evidence.flatMap(item =>
    item.kind === 'search_hit' ? [item.hit] : [],
  );
}

function collectKeys(hits: SearchHit[]): LinkedKey[] {
  const keys = new Map<string, LinkedKey>();
  const add = (lookup: LinkedLookup, key: string) =>
    keys.set(identity(lookup, key), [lookup, key]);
  for (const hit of hits) {
    for (const analysis of wordKeys(hit)) {
      if (analysis.lexicon) add('lexicon', analysis.lexicon);
      for (const code of analysis.grammar) add('grammar_info', code);
      if (analysis.proper_name) add('proper_name', analysis.proper_name);
    }
  }
  return [...keys.values()];
}

function boundedHits(hits: SearchHit[], available: Set<string> | null): number {
  const keys = new Map<string, LinkedKey>();
  for (const [index, hit] of hits.entries()) {
    for (const key of collectKeys([hit])) {
      const id = identity(...key);
      if (!available || available.has(id)) keys.set(id, key);
    }
    if (!fitsLinkedState([...keys.values()])) return index;
  }
  return hits.length;
}

function priority(workload: SearchWorkload): EvidenceFocus[] {
  const order: EvidenceFocus[] =
    workload.mode === 'word_analysis'
      ? ['grammar', 'lexicon', 'occurrences', 'names']
      : ['lexicon', 'grammar', 'occurrences', 'names'];
  const focus = workload.focus as EvidenceFocus | undefined;
  return focus ? [focus, ...order.filter(kind => kind !== focus)] : order;
}

function orderedKeys(
  hits: SearchHit[],
  workload: SearchWorkload,
  present: Set<string> | null,
) {
  const order = priority(workload);
  return collectKeys(hits)
    .filter(key => !present || present.has(identity(...key)))
    .sort(
      ([left], [right]) =>
        order.indexOf(LINKED_FOCUS[left]) - order.indexOf(LINKED_FOCUS[right]),
    );
}

function orderEvidence(batch: Batch, workload: SearchWorkload) {
  const order = priority(workload);
  const rank = (item: EvidenceItem) => {
    if (item.kind !== 'language_aid') return order.indexOf('occurrences');
    const lookup = (Object.keys(LINKED_KIND) as LinkedLookup[]).find(
      key => LINKED_KIND[key] === item.span.kind,
    );
    return order.indexOf(lookup ? LINKED_FOCUS[lookup] : 'lexicon');
  };
  batch.evidence.sort((left, right) => rank(left) - rank(right));
}

/** Reuse the exact aid reader within a word page. An unfinished entry keeps
 * the same position and moves to the next batch when the current one is full. */
async function attachLinkedAids(
  session: ReadSession,
  batch: Batch,
  workload: SearchWorkload,
  pending: LinkedState,
  guidance: string,
) {
  const delivered = new Map<string, string[]>();
  while (pending.keys.length && session.budget.canQuery()) {
    const [lookup, key] = pending.keys[0];
    const aid = await aidBatch(
      session,
      {...workload, lookup, key, sources: null},
      null,
      guidance,
      [],
      {envelopeReserve: 0},
    );
    const candidate = {
      ...batch,
      evidence: [...batch.evidence, ...aid.evidence],
      citations: [...batch.citations, ...aid.citations],
      limitations: [
        ...batch.limitations,
        ...aid.limitations.filter(
          item => !(item.state === 'missing_evidence' && item.scope === key),
        ),
      ],
    };
    const next = {
      ...pending,
      keys: aid.continuation ? pending.keys : pending.keys.slice(1),
      aid: aid.continuation,
      check: aid.continuation ? false : pending.check,
    };
    await setLinkedContinuation(candidate, workload, next);
    if (
      utf8Length(JSON.stringify(candidate)) > session.budget.limits.resultBytes
    )
      break;
    Object.assign(batch, candidate);
    Object.assign(pending, next);
    delivered.set(
      identity(lookup, key),
      aid.citations.map(citation => citation.span_id),
    );
    if (pending.aid) break;
  }
  return delivered;
}

function linkAnalyses(
  batch: Batch,
  hits: SearchHit[],
  delivered: Map<string, string[]>,
  cap: number,
) {
  const spans = (lookup: LinkedLookup, key: string | null) =>
    key ? (delivered.get(identity(lookup, key)) ?? []) : [];
  for (const hit of hits) {
    delete hit.aid_matches;
    const matches = wordKeys(hit)
      .map(analysis => ({
        analysis_id: analysis.analysis_id,
        lexicon: spans('lexicon', analysis.lexicon),
        grammar: [
          ...new Set(
            analysis.grammar.flatMap(key => spans('grammar_info', key)),
          ),
        ],
        proper_name: spans('proper_name', analysis.proper_name),
      }))
      .filter(
        item =>
          item.lexicon.length || item.grammar.length || item.proper_name.length,
      );
    if (matches.length) {
      hit.aid_matches = matches;
      if (utf8Length(JSON.stringify(batch)) > cap) delete hit.aid_matches;
    }
  }
}
