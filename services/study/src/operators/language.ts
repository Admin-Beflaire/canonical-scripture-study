import { compareUtf8, isIdentifier, utf8Length } from '../read/bytes.ts';
import { readSpans } from '../read/evidence.ts';
import { PagedIndexSearch, SUPPORTED_LOOKUPS, UNSUPPORTED_LOOKUPS, type LookupKind, type SearchAdapter, type SearchHit } from '../read/search.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError, limitation, type Limitation } from '../read/states.ts';
import type { Batch, EvidenceItem } from '../results/batch.ts';
import { searchBatch } from '../results/search-batch.ts';
import { normalizeKey } from '../scope/keys.ts';

/** Capability each lookup needs from a selected index. */
const CAPABILITY: Record<string, string> = { word: 'word_exact', form: 'form_exact', lemma: 'lemma_exact', grammar: 'grammar_exact' };

export interface LanguageWorkload { mode: string; depth: string; language: string; lookup: string; key: string; sources: string[] | null }

/** Most sources one search covers (the search interface's own limit). */
export const MAX_SEARCH_SOURCES = 20;

/** The selected sources offering a capability, in a stable order. More than one search can
 *  cover is refused with a clear request to name sources, never silently narrowed. */
export async function sourcesWith(session: ReadSession, capability: string): Promise<string[]> {
  const sources = new Set<string>();
  let after: [string, string] | null = null;
  for (;;) {
    const { rows, more }: { rows: Record<string, unknown>[]; more: boolean } = await session.query('release_sources', { capability, after });
    for (const row of rows) if (Number(row.available) > 0) sources.add(String(row.source_revision_id));
    if (sources.size > MAX_SEARCH_SOURCES)
      throw new ReadError('invalid_request', `More than ${MAX_SEARCH_SOURCES} selected sources offer this search; name up to ${MAX_SEARCH_SOURCES} in sources`);
    if (!more || !rows.length) break;
    after = [String(rows.at(-1)!.source_revision_id), String(rows.at(-1)!.capability)];
  }
  return [...sources].sort(compareUtf8);
}

/** Exact word, form, lemma or grammar occurrences through the read search interface. Keys typed
 *  by the host are normalized with their script's rule; the batch states what was searched. */
export async function languageBatch(session: ReadSession, workload: LanguageWorkload, continuation: string | null,
                                    guidanceVersion: string, notes: Limitation[] = [], adapter: SearchAdapter = new PagedIndexSearch()): Promise<Batch> {
  const lookup = workload.lookup;
  if (![...SUPPORTED_LOOKUPS, ...UNSUPPORTED_LOOKUPS].includes(lookup as LookupKind))
    throw new ReadError('invalid_request', `Unknown lookup "${lookup}"; use word, form, lemma or grammar`);
  if (typeof workload.key !== 'string' || !workload.key.trim()) throw new ReadError('invalid_request', 'A search lead needs a key');
  let sources = workload.sources;
  if (sources != null && (!Array.isArray(sources) || !sources.length || !sources.every(s => isIdentifier(s))))
    throw new ReadError('invalid_request', 'Sources are source revision IDs as listed by the study tool');
  if (sources == null) {
    sources = UNSUPPORTED_LOOKUPS.includes(lookup as LookupKind) ? ['none'] : await sourcesWith(session, CAPABILITY[lookup]);
    if (!sources.length) throw new ReadError('missing_index', `No selected source offers ${lookup} search`);
  }
  const batch = await searchBatch(session, adapter, { mode: workload.mode, depth: workload.depth, language: workload.language, lookup,
    key: normalizeKey(lookup, workload.key), sources }, continuation, guidanceVersion, notes);
  if (SUPPORTED_LOOKUPS.includes(lookup as LookupKind)) await attachWordAids(session, batch);
  return batch;
}


/** Evidence attached by selected Strong/morphology keys, not by guessed word senses.
 * Each distinct key is fetched at most once per batch; a bounded, release-scoped cache
 * reuses verified small entries across continuations in the same Worker instance. */
type AidKind = 'lexicon' | 'grammar_info' | 'proper_name';
type AidItem = Extract<EvidenceItem, { kind: 'language_aid' }>;
interface Key { lookup: AidKind; key: string }
interface AnalysisKeys { analysis_id: string; lexicon: string | null; grammar: string[]; proper_name: string | null }
const MAX_AID_KEYS = 4;
const MAX_AID_ROWS = 12;
const MAX_AID_ROWS_PER_KEY = 8;
const MAX_CACHED_KEYS = 8;
const CACHE_BYTE_CAP = 48 * 1024;
const WORD_AID_CACHE = new WeakMap<object, { release: string; values: Map<string, AidItem[]> }>();
const cacheKey = (lookup: AidKind, key: string) => lookup + ':' + key;
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function wordKeys(hit: SearchHit): AnalysisKeys[] {
  if (!Array.isArray(hit.analyses)) return [];
  return hit.analyses.filter(isObject).map(a => {
    // Source analyses may have a disambiguating trailing letter (e.g. H7225G).
    // Language-aid lexicon rows are indexed by the base Strong number.
    const strong = typeof a.lemma_id === 'string' ? a.lemma_id.match(/^([HG])(\d{1,5})[A-Z]?$/i) : null;
    const fullTag = typeof a.lemma_id === 'string' ? a.lemma_id.match(/^([HG])(\d{1,5})([A-Z]?)$/i) : null;
    const proper_name = fullTag ? fullTag[1].toUpperCase() + fullTag[2].padStart(4, '0') + fullTag[3] : null;
    const lemma = strong ? strong[1].toUpperCase() + strong[2].padStart(4, '0') : null;
    const sourceGrammar = isObject(a.grammar) ? a.grammar : null;
    const morphology = typeof sourceGrammar?.morphology === 'string' ? sourceGrammar.morphology : '';
    const prefix = sourceGrammar?.language === 'hebrew' ? 'H' : sourceGrammar?.language === 'aramaic' ? 'A' : '';
    const grammar = morphology.split('/').map(part =>
      prefix && part ? prefix + part : part).filter(x => isIdentifier(x, 200));
    return { analysis_id: typeof a.analysis_id === 'string' ? a.analysis_id : '', lexicon: lemma, grammar, proper_name };
  });
}

function aidDetails(raw: unknown): Record<string, unknown> {
  const details: unknown = JSON.parse(String(raw));
  if (!isObject(details)) throw new Error('Unreadable language-aid metadata');
  // Keep the same explicit BDB links as the independent lexicon lookup.
  const index = typeof details.entry_id === 'string' ? details.entry_id.match(/^oshb-lexical-index:([0-9a-f]{40}):/) : null;
  if (index && Array.isArray(details.references))
    details.linked_entry_keys = [...new Set(details.references.flatMap(ref =>
      Array.isArray(ref) && isIdentifier(ref[0], 200) ? ['oshb-bdb:' + index[1] + ':' + ref[0]] : []))];
  return details;
}

/** Adds uniquely retrieved attributed entries as separate evidence and links each word analysis
 * to them. Missing, large and undisplayed entries remain available via independent lookups. */
export async function attachWordAids(session: ReadSession, batch: Batch): Promise<void> {
  const hits = batch.evidence.filter((item): item is Extract<EvidenceItem, {kind: 'search_hit'}> => item.kind === 'search_hit')
    .map(item => item.hit);
  if (!hits.length) return;
  const wanted = new Map<SearchHit, AnalysisKeys[]>();
  const keys = new Map<string, Key>();
  for (const hit of hits) {
    const analyses = wordKeys(hit);
    wanted.set(hit, analyses);
    for (const analysis of analyses) {
      if (analysis.proper_name) keys.set(cacheKey('proper_name', analysis.proper_name), { lookup: 'proper_name', key: analysis.proper_name });
      if (analysis.lexicon) keys.set(cacheKey('lexicon', analysis.lexicon), { lookup: 'lexicon', key: analysis.lexicon });
      for (const code of analysis.grammar) keys.set(cacheKey('grammar_info', code), { lookup: 'grammar_info', key: code });
    }
  }
  const cap = session.budget.limits.resultBytes;
  const note = (state: Limitation['state'], scope: string, detail: string) => {
    const item = limitation(state, scope, detail);
    batch.limitations.push(item);
    if (utf8Length(JSON.stringify(batch)) > cap) batch.limitations.pop();
  };
  const choice = [...keys].slice(0, MAX_AID_KEYS);
  if (keys.size > choice.length) note('budget', 'word_aids', 'Additional word keys need separate lookups within the batch allowance');
  const existing = WORD_AID_CACHE.get(session.objects);
  const cached = existing?.release === session.release.id ? existing.values : new Map<string, AidItem[]>();
  if (existing?.release !== session.release.id) WORD_AID_CACHE.set(session.objects, { release: session.release.id, values: cached });
  const values = new Map<string, AidItem[]>();
  type Row = { span_id: string; provider: string; details_json: unknown };
  const fresh = new Map<string, { rows: Row[]; complete: boolean }>();
  let rowCount = 0;
  for (const [identity, key] of choice) {
    if (cached.has(identity)) { values.set(identity, cached.get(identity)!); continue; }
    // Reserve a D1 call to resolve the selected bodies after the key queries.
    if (!session.budget.canQuery(2)) {
      note('budget', identity, 'No D1 allowance for attached evidence; independent lookup remains available');
      continue;
    }
    const page = await session.queryIfAvailable(key.lookup === 'lexicon' ? 'lexicon_strong' : key.lookup === 'proper_name' ? 'proper_name' : 'grammar_expansion',
      { key: key.key, after: null });
    if (page === null) { note('budget', identity, 'No D1 allowance for the language-aid lookup'); continue; }
    const count = Math.min(page.rows.length, MAX_AID_ROWS_PER_KEY, MAX_AID_ROWS - rowCount);
    const rows = page.rows.slice(0, count).map(row => ({
      span_id: String(row.span_id), provider: String(row.provider), details_json: row.details_json,
    }));
    rowCount += rows.length;
    const complete = !page.more && count === page.rows.length;
    if (!complete) note('budget', identity, 'Other attributed entries remain; use the independent lookup for all alternatives');
    fresh.set(identity, { rows, complete });
    if (rowCount >= MAX_AID_ROWS) break;
  }
  const ids = [...new Set([...fresh.values()].flatMap(value => value.rows.map(row => row.span_id)))];
  if (ids.length) {
    const read = await readSpans(session, ids);
    for (const issue of read.limitations) note(issue.state, issue.scope, issue.detail);
    if (read.remaining.length) note('budget', 'word_aids', 'Some linked source bodies need another request');
    const spans = new Map(read.spans.map(span => [span.span_id, span]));
    for (const [identity, entry] of fresh) {
      const items: AidItem[] = [];
      let complete = entry.complete;
      for (const row of entry.rows) {
        const span = spans.get(row.span_id);
        if (!span || span.text === null) { complete = false; continue; }
        try { items.push({ kind: 'language_aid', span, provider: row.provider, details: aidDetails(row.details_json) }); }
        catch { note('corrupt', identity, 'Unreadable linked language-aid metadata'); complete = false; }
      }
      values.set(identity, items);
      if (complete && utf8Length(JSON.stringify(items)) <= CACHE_BYTE_CAP) {
        cached.delete(identity);
        cached.set(identity, items);
        if (cached.size > MAX_CACHED_KEYS) cached.delete(cached.keys().next().value!);
      }
    }
  } else for (const [identity, entry] of fresh) {
    values.set(identity, []);
    if (entry.complete) cached.set(identity, []);
  }
  const delivered = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const [identity] of choice) {
    for (const item of values.get(identity) ?? []) {
      const sid = item.span.span_id;
      if (!seen.has(sid)) {
        const citation = { source_revision_id: item.span.source_revision_id, span_id: sid,
          coordinate_version: item.span.coordinate_version, segments: item.span.segments };
        const bytes = utf8Length(JSON.stringify(item));
        if (!session.budget.canReturn(bytes)) {
          note('budget', identity, 'Linked evidence exceeds this batch; use the separate lookup');
          continue;
        }
        batch.evidence.push(item);
        batch.citations.push(citation);
        if (utf8Length(JSON.stringify(batch)) > cap) {
          batch.evidence.pop(); batch.citations.pop();
          note('budget', identity, 'Linked evidence exceeds this batch; use the separate lookup');
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
  for (const hit of hits) {
    const matches = (wanted.get(hit) ?? []).map(a => ({
      analysis_id: a.analysis_id,
      lexicon: a.lexicon ? delivered.get(cacheKey('lexicon', a.lexicon)) ?? [] : [],
      grammar: [...new Set(a.grammar.flatMap(code => delivered.get(cacheKey('grammar_info', code)) ?? []))],
      proper_name: a.proper_name ? delivered.get(cacheKey('proper_name', a.proper_name)) ?? [] : [],
    })).filter(a => a.lexicon.length || a.grammar.length || a.proper_name.length);
    if (!matches.length) continue;
    hit.aid_matches = matches;
    if (utf8Length(JSON.stringify(batch)) > cap) {
      delete hit.aid_matches;
      note('budget', 'word_aids', 'Not every occurrence can carry evidence links in this batch');
    }
  }
}
