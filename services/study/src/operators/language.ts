import {compareUtf8, isIdentifier, utf8Length} from '../read/bytes.ts';
import {aidSpanId, readAidEntries} from '../read/aid-entries.ts';
import {
  PagedIndexSearch,
  SUPPORTED_LOOKUPS,
  UNSUPPORTED_LOOKUPS,
  type LookupKind,
  type SearchAdapter,
  type SearchHit,
} from '../read/search.ts';
import type {ReadSession} from '../read/session.ts';
import {ReadError, limitation, type Limitation} from '../read/states.ts';
import type {Batch, EvidenceItem} from '../results/batch.ts';
import {
  searchBatch,
  normalizeSearchWorkload,
  SEARCH_CHECKS,
} from '../results/search-batch.ts';
import {
  encodeContinuation,
  resumeContinuation,
} from '../results/continuation.ts';
import {aidBatch} from './aids.ts';
import {normalizeKey} from '../scope/keys.ts';

/** Capability each lookup needs from a selected index. */
const CAPABILITY: Record<string, string> = {
  word: 'word_exact',
  form: 'form_exact',
  lemma: 'lemma_exact',
  grammar: 'grammar_exact',
};

export interface LanguageWorkload {
  mode: string;
  depth: string;
  language: string;
  lookup: string;
  key: string;
  sources: string[] | null;
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
      await session.query('release_sources', {capability, after});
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
  });
  type NameState = {
    tags: string[];
    aid: string | null;
    search: string | null;
    scan: boolean;
  };
  const checks = {
    ...SEARCH_CHECKS,
    word_names: (pos: unknown, key: unknown) => {
      if (
        key !== null ||
        !isObject(pos) ||
        Object.keys(pos).sort().join(',') !== 'aid,scan,search,tags'
      )
        return false;
      return (
        typeof pos.scan === 'boolean' &&
        (pos.scan === false || pos.aid === null) &&
        Array.isArray(pos.tags) &&
        pos.tags.length > 0 &&
        pos.tags.length <= 16 &&
        pos.tags.every(
          (tag: unknown) =>
            typeof tag === 'string' && /^[HG]\d{4,5}[A-Za-z]?$/.test(tag),
        ) &&
        (pos.aid === null ||
          (typeof pos.aid === 'string' && pos.aid.length <= 2048)) &&
        (pos.search === null ||
          (typeof pos.search === 'string' && pos.search.length <= 2048))
      );
    },
  };
  const state = continuation
    ? await resumeContinuation(continuation, normalized, checks)
    : null;
  if (state?.op === 'word_names') {
    const pending = state.pos as NameState;
    if (pending.scan) {
      const found = await presentNameTags(session, pending.tags);
      const next = {...pending, scan: false, tags: found};
      const token = found.length
        ? await encodeContinuation(normalized, {
            op: 'word_names',
            pos: next,
            key: null,
          })
        : pending.search;
      return {
        release_id: session.release.id,
        mode: normalized.mode,
        depth: normalized.depth,
        delivered_scope: {
          lookup,
          key: normalized.key,
          sources,
          name_presence_checked: true,
        },
        context_scope: null,
        evidence: [],
        citations: [],
        searched_scope: [],
        coverage: [],
        limitations: [],
        remaining: token
          ? {word_names: found.length, search: !!pending.search}
          : null,
        continuation: token,
        guidance_version: guidanceVersion,
      };
    }
    const tag = pending.tags[0];
    const result = await aidBatch(
      session,
      {...normalized, lookup: 'proper_name', key: tag, sources: null},
      pending.aid,
      guidanceVersion,
    );
    // No matching identity is ordinary for non-name Strong tags.
    result.limitations = result.limitations.filter(
      item => !(item.state === 'missing_evidence' && item.scope === tag),
    );
    result.delivered_scope = {
      lookup,
      key: normalized.key,
      word_sources: sources,
      proper_name_for: tag,
      sources: null,
    };
    const next = result.continuation
      ? {...pending, aid: result.continuation}
      : {...pending, tags: pending.tags.slice(1), aid: null};
    result.continuation = next.tags.length
      ? await encodeContinuation(normalized, {
          op: 'word_names',
          pos: next,
          key: null,
        })
      : pending.search;
    result.remaining = result.continuation
      ? {word_names: next.tags.length, search: !!pending.search}
      : null;
    return result;
  }
  // Check candidate tags together, before bounding a page by actual names.
  let present: Set<string> | null = null;
  const batch = await searchBatch(
    session,
    adapter,
    normalized,
    continuation,
    guidanceVersion,
    notes,
    async hits => {
      const all = [
        ...new Set(
          hits.flatMap(hit =>
            wordKeys(hit).flatMap(a => (a.proper_name ? [a.proper_name] : [])),
          ),
        ),
      ];
      if (!all.length) {
        present = new Set();
        return hits.length;
      }
      // Preserve the existing room for lexicon, grammar and their span read.
      // If the search already spent that room, screen in the next batch instead.
      const checked = session.budget.canQuery(4)
        ? await session.queryIfAvailable('proper_name_presence', {tags: all})
        : null;
      present = checked ? new Set(parsePresence(checked.rows, all)) : null;
      const tags = new Set<string>();
      for (let i = 0; i < hits.length; i++) {
        const next = new Set([
          ...tags,
          ...wordKeys(hits[i]).flatMap(a =>
            a.proper_name && (!present || present.has(a.proper_name))
              ? [a.proper_name]
              : [],
          ),
        ]);
        if (next.size > 16) return i;
        for (const tag of next) tags.add(tag);
      }
      return hits.length;
    },
  );
  if (SUPPORTED_LOOKUPS.includes(lookup as LookupKind)) {
    const completed = await attachWordAids(session, batch);
    const available = present as Set<string> | null;
    const tags = [
      ...new Set(
        batch.evidence.flatMap(item =>
          item.kind === 'search_hit'
            ? wordKeys(item.hit).flatMap(a =>
                a.proper_name &&
                !completed.has(a.proper_name) &&
                (!available || available.has(a.proper_name))
                  ? [a.proper_name]
                  : [],
              )
            : [],
        ),
      ),
    ];
    if (tags.length) {
      batch.continuation = await encodeContinuation(normalized, {
        op: 'word_names',
        pos: {
          tags,
          aid: null,
          search: batch.continuation,
          scan: available === null,
        },
        key: null,
      });
      batch.remaining = {word_names: tags.length, search: !!batch.remaining};
    }
  }
  return batch;
}

function parsePresence(
  rows: Record<string, unknown>[],
  requested: string[],
): string[] {
  try {
    const value: unknown = JSON.parse(String(rows[0]?.tags));
    if (
      !Array.isArray(value) ||
      !value.every(tag => typeof tag === 'string' && requested.includes(tag))
    )
      throw new Error();
    return [...new Set(value)];
  } catch {
    throw new ReadError('corrupt', 'Unreadable proper-name presence result');
  }
}

async function presentNameTags(
  session: ReadSession,
  tags: string[],
): Promise<string[]> {
  const result = await session.query('proper_name_presence', {tags});
  return parsePresence(result.rows, tags);
}

/** Evidence attached by selected Strong and morphology keys. */
type AidKind = 'lexicon' | 'grammar_info' | 'proper_name';
type AidItem = Extract<EvidenceItem, {kind: 'language_aid'}>;
interface Key {
  lookup: AidKind;
  key: string;
}
interface AnalysisKeys {
  analysis_id: string;
  lexicon: string | null;
  grammar: string[];
  proper_name: string | null;
}
const MAX_AID_KEYS = 4;
const MAX_AID_ROWS = 12;
const MAX_AID_ROWS_PER_KEY = 8;
const cacheKey = (lookup: AidKind, key: string) => lookup + ':' + key;
const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

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

/** Adds uniquely retrieved attributed entries as separate evidence and links each word analysis
 * to them. Missing, large and undisplayed entries remain available via independent lookups. */
export async function attachWordAids(
  session: ReadSession,
  batch: Batch,
): Promise<Set<string>> {
  const hits = batch.evidence
    .filter(
      (item): item is Extract<EvidenceItem, {kind: 'search_hit'}> =>
        item.kind === 'search_hit',
    )
    .map(item => item.hit);
  if (!hits.length) return new Set();
  const wanted = new Map<SearchHit, AnalysisKeys[]>();
  const keys = new Map<string, Key>();
  const nameKeys = new Map<string, Key>();
  for (const hit of hits) {
    const analyses = wordKeys(hit);
    wanted.set(hit, analyses);
    for (const analysis of analyses) {
      if (analysis.proper_name)
        nameKeys.set(cacheKey('proper_name', analysis.proper_name), {
          lookup: 'proper_name',
          key: analysis.proper_name,
        });
      if (analysis.lexicon)
        keys.set(cacheKey('lexicon', analysis.lexicon), {
          lookup: 'lexicon',
          key: analysis.lexicon,
        });
      for (const code of analysis.grammar)
        keys.set(cacheKey('grammar_info', code), {
          lookup: 'grammar_info',
          key: code,
        });
    }
  }
  // Existing lexical and grammar evidence keeps priority across all analyses.
  for (const [key, value] of nameKeys) keys.set(key, value);
  const cap = session.budget.limits.resultBytes;
  const note = (state: Limitation['state'], scope: string, detail: string) => {
    const item = limitation(state, scope, detail);
    batch.limitations.push(item);
    if (utf8Length(JSON.stringify(batch)) > cap) batch.limitations.pop();
  };
  const choice = [...keys].slice(0, MAX_AID_KEYS);
  if (keys.size > choice.length)
    note(
      'budget',
      'word_aids',
      'Additional word keys need separate lookups within the batch allowance',
    );
  const values = new Map<string, AidItem[]>();
  const fresh = new Map<
    string,
    {rows: Record<string, unknown>[]; complete: boolean}
  >();
  let rowCount = 0;
  for (const [identity, key] of choice) {
    // Reserve a D1 call to resolve the selected bodies after the key queries.
    if (!session.budget.canQuery(2)) {
      note(
        'budget',
        identity,
        'No D1 allowance for attached evidence; independent lookup remains available',
      );
      continue;
    }
    const page = await session.queryIfAvailable(
      key.lookup === 'lexicon'
        ? 'lexicon_strong'
        : key.lookup === 'proper_name'
          ? 'proper_name'
          : 'grammar_expansion',
      {key: key.key, after: null},
    );
    if (page === null) {
      note('budget', identity, 'No D1 allowance for the language-aid lookup');
      continue;
    }
    const count = Math.min(
      page.rows.length,
      MAX_AID_ROWS_PER_KEY,
      MAX_AID_ROWS - rowCount,
    );
    const rows = page.rows.slice(0, count);
    rowCount += rows.length;
    const complete = !page.more && count === page.rows.length;
    if (!complete)
      note(
        'budget',
        identity,
        'Other attributed entries remain; use the independent lookup for all alternatives',
      );
    fresh.set(identity, {rows, complete});
    if (rowCount >= MAX_AID_ROWS) break;
  }
  const rows = [...fresh.values()].flatMap(value => value.rows);
  if (rows.length) {
    const read = await readAidEntries(session, rows);
    for (const issue of read.limitations)
      note(issue.state, issue.scope, issue.detail);
    if (read.remaining.length)
      note('budget', 'word_aids', 'Some linked entries need another request');
    const entries = new Map(
      read.entries.map(entry => [entry.span.span_id, entry]),
    );
    for (const [identity, entry] of fresh) {
      const items: AidItem[] = [];
      let complete = entry.complete;
      for (const row of entry.rows) {
        const found = entries.get(aidSpanId(row));
        if (!found || found.span.text === null) {
          complete = false;
          continue;
        }
        items.push({
          kind: 'language_aid',
          span: found.span,
          provider: found.provider,
          details: found.details,
        });
      }
      values.set(identity, items);
      entry.complete = complete;
    }
  }
  const delivered = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const [identity] of choice) {
    for (const item of values.get(identity) ?? []) {
      const sid = item.span.span_id;
      if (!seen.has(sid)) {
        const citation = {
          source_revision_id: item.span.source_revision_id,
          span_id: sid,
          coordinate_version: item.span.coordinate_version,
          segments: item.span.segments,
        };
        const bytes = utf8Length(JSON.stringify(item));
        if (!session.budget.canReturn(bytes)) {
          note(
            'budget',
            identity,
            'Linked evidence exceeds this batch; use the separate lookup',
          );
          continue;
        }
        batch.evidence.push(item);
        batch.citations.push(citation);
        if (utf8Length(JSON.stringify(batch)) > cap) {
          batch.evidence.pop();
          batch.citations.pop();
          note(
            'budget',
            identity,
            'Linked evidence exceeds this batch; use the separate lookup',
          );
          continue;
        }
        session.budget.spendResult(bytes);
        seen.add(sid);
      }
      const refs = delivered.get(identity) ?? [];
      if (!refs.includes(sid)) refs.push(sid);
      delivered.set(identity, refs);
    }
  }
  const completedNames = new Set<string>();
  for (const [identity, key] of choice) {
    if (key.lookup !== 'proper_name' || !values.has(identity)) continue;
    const items = values.get(identity)!;
    const complete = fresh.get(identity)?.complete === true;
    if (complete && (delivered.get(identity)?.length ?? 0) === items.length)
      completedNames.add(key.key);
  }
  for (const hit of hits) {
    const matches = (wanted.get(hit) ?? [])
      .map(a => ({
        analysis_id: a.analysis_id,
        lexicon: a.lexicon
          ? (delivered.get(cacheKey('lexicon', a.lexicon)) ?? [])
          : [],
        grammar: [
          ...new Set(
            a.grammar.flatMap(
              code => delivered.get(cacheKey('grammar_info', code)) ?? [],
            ),
          ),
        ],
        proper_name: a.proper_name
          ? (delivered.get(cacheKey('proper_name', a.proper_name)) ?? [])
          : [],
      }))
      .filter(
        a => a.lexicon.length || a.grammar.length || a.proper_name.length,
      );
    if (!matches.length) continue;
    hit.aid_matches = matches;
    if (utf8Length(JSON.stringify(batch)) > cap) {
      delete hit.aid_matches;
      note(
        'budget',
        'word_aids',
        'Not every occurrence can carry evidence links in this batch',
      );
    }
  }
  return completedNames;
}
