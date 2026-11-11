import { canonicalJson, compareUtf8, isIdentifier, isSafeCount, utf8Length } from './bytes.ts';
import { candidateDirectoryPages, checkManifest, directoryEntries, entryOverlaps, type DirectoryEntry, type IndexManifest } from './manifest.ts';
import { artifactFrom, readArtifact, type RegisteredArtifact } from './objects.ts';
import type { ReadSession } from './session.ts';
import { ReadError, limitation, type Limitation } from './states.ts';

/** Source-scoped search contract used by Study operators. Only the adapter knows the
 *  index format, object layout and page directory; operators see attributed native
 *  references, searched scope, coverage, limitations and a remaining position. */
export type LookupKind = 'word' | 'lemma' | 'form' | 'grammar' | 'phrase' | 'proximity' | 'fuzzy';
export const SUPPORTED_LOOKUPS: readonly LookupKind[] = ['word', 'lemma', 'form', 'grammar'];
export const UNSUPPORTED_LOOKUPS: readonly LookupKind[] = ['phrase', 'proximity', 'fuzzy'];

/** Opaque to operators; carried inside a validated continuation. `order` is the output's
 *  `order_range` start; `dir`/`entry` name the directory entry of the next postings page to read;
 *  `anchor` is the postings page holding `after`, the last delivered occurrence. */
export interface PageRef { file: string; offset: number; length: number; sha256: string }
export interface SearchPosition { source: string; output: string; order: number; dir: number; entry: number;
  after: [number, string] | null; anchor: PageRef | null }

export interface SearchRequest { lookup: string; key: string; sources: string[]; position?: SearchPosition | null }

export interface SearchHit {
  source_revision_id: string; span_id: string; coordinate_version: string; native_order: number; occurrence_id: string;
  native_reference: { schema_version: string; source_revision_id: string; coordinate_version: string; segments: { unit_id: string; start: number; end: number }[] };
  form?: string; analyses?: unknown[];
}

/** What this request searched. `complete` covers the stated extent from `resumed_after`
 *  (exclusive) onwards; occurrences up to it were delivered by earlier batches. */
export interface SearchedScope {
  source_revision_id: string; capability: string; coverage_state: string; unit_ids: string[];
  normalization_rule: string; complete: boolean; resumed_after: [number, string] | null;
}

/** `complete`: every selected candidate page was read and no gaps were found.
 *  `no_match`: complete, and nothing matched in the stated extent.
 *  `incomplete`: finished, but some extent had a missing index, corruption or failure (see limitations).
 *  `continues`: the allowance ran out; resume from `remaining`.
 *  `unsupported_capability`: the lookup kind is not offered; nothing was searched. */
export type SearchState = 'complete' | 'no_match' | 'incomplete' | 'continues' | 'unsupported_capability';

export interface SearchResult {
  state: SearchState; lookup: string; key: string; hits: SearchHit[]; searched: SearchedScope[];
  limitations: Limitation[]; remaining: SearchPosition | null; ranked: false;
}

export interface SearchAdapter { search(session: ReadSession, request: SearchRequest): Promise<SearchResult> }

const CAPABILITY: Record<string, string> = { word: 'word_exact', lemma: 'lemma_exact', form: 'form_exact', grammar: 'grammar_exact' };

/** Normalises and checks a request. Unknown kinds are invalid; known unsupported kinds are explicit. */
export function checkRequest(request: SearchRequest): SearchRequest {
  if (!request || typeof request !== 'object') throw new ReadError('invalid_request', 'Missing search request');
  if (![...SUPPORTED_LOOKUPS, ...UNSUPPORTED_LOOKUPS].includes(request.lookup as LookupKind)) throw new ReadError('invalid_request', 'Unknown lookup kind');
  if (typeof request.key !== 'string' || request.key.length < 1 || request.key.length > 256 || /[\uD800-\uDFFF]/u.test(request.key))
    throw new ReadError('invalid_request', 'Invalid search key');
  const sources = request.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 20 || !sources.every(s => isIdentifier(s)) || new Set(sources).size !== sources.length)
    throw new ReadError('invalid_request', 'Expected a short list of distinct source revisions');
  const position = request.position ?? null;
  if (position !== null) {
    const ok = position && typeof position === 'object' && sources.includes(position.source)
      && (position.output === '' ? position.order === 0 && position.dir === 0 && position.entry === 0 && position.after === null : isIdentifier(position.output))
      && isSafeCount(position.order) && isSafeCount(position.dir) && isSafeCount(position.entry)
      && (position.after === null ? position.dir === 0 && position.entry === 0 && position.anchor === null
        : !!position.anchor && typeof position.anchor === 'object' && isIdentifier(position.anchor.file) && isSafeCount(position.anchor.offset)
          && isSafeCount(position.anchor.length) && position.anchor.length > 0 && typeof position.anchor.sha256 === 'string'
          && /^[0-9a-f]{64}$/.test(position.anchor.sha256))
      && (position.after === null || (Array.isArray(position.after) && position.after.length === 2
        && isSafeCount(position.after[0]) && isIdentifier(position.after[1])));
    if (!ok) throw new ReadError('invalid_request', 'Invalid search position');
  }
  return { lookup: request.lookup, key: request.key, sources: [...sources].sort(compareUtf8), position };
}

interface Group { source: string; output: string; state: string; limitation: string | null; method: string;
  manifestId: string | null; order: [number, number] | null; artifacts: Map<string, RegisteredArtifact> }

/** Verified manifests and directory pages of selected immutable outputs, per isolate. Keys carry
 *  the release, source, output, artifact and digest, format and processing basis; an entry is only
 *  consulted after this request's D1 read has confirmed the artifact is selected now. */
const MANIFESTS = new Map<string, IndexManifest>();
const DIRECTORY_PAGES = new Map<string, DirectoryEntry[]>();
const CACHE_ENTRIES = 64;
export function clearSearchCache() { MANIFESTS.clear(); DIRECTORY_PAGES.clear(); }
export function searchCacheSize() { return MANIFESTS.size + DIRECTORY_PAGES.size; }
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

/** Reads only the D1 rows and R2 pages needed for one exact key, in deterministic order:
 *  source revision, index output by `order_range`, then (native order, occurrence ID). */
export class PagedIndexSearch implements SearchAdapter {
  async search(session: ReadSession, input: SearchRequest): Promise<SearchResult> {
    const request = checkRequest(input);
    const result: SearchResult = { state: 'complete', lookup: request.lookup, key: request.key, hits: [], searched: [], limitations: [], remaining: null, ranked: false };
    if (UNSUPPORTED_LOOKUPS.includes(request.lookup as LookupKind)) {
      result.state = 'unsupported_capability';
      result.limitations.push(limitation('unsupported_capability', request.lookup, `${request.lookup} search is not offered by the current indexes; nothing was searched`));
      return result;
    }
    const resumed = request.position !== null;
    const capability = CAPABILITY[request.lookup];
    const searchKey = request.lookup === 'word' ? request.key : `${request.lookup}:${request.key}`;
    const start: SearchPosition = request.position ?? { source: request.sources[0], output: '', order: 0, dir: 0, entry: 0, after: null, anchor: null };
    if (!session.canQuery()) return finish(result, start, resumed);
    const { rows, more } = await session.query('index_files', { source_revision_ids: request.sources, capability,
      after: [start.source, start.output === '' ? -1 : start.order, start.output] });
    const groups = groupRows(rows);
    let next: Group | undefined;
    if (more) {
      next = groups.pop();
      if (!next) throw new ReadError('exceeds_limits', 'One index output has more registered files than a query may return');
    }
    // A resume anchor must name an index output selected now, at the same order position.
    const anchor = groups[0] ?? next;
    if (start.output !== '' && (!anchor || anchor.source !== start.source || anchor.output !== start.output || anchor.order?.[0] !== start.order))
      throw new ReadError('invalid_request', 'Continuation does not match the selected index; start the search again');
    const seen = new Set(groups.map(g => g.source));
    for (const source of request.sources) {
      // Sources before the resume point, or a resumed source past its first output, were reported earlier.
      const done = compareUtf8(source, start.source) < 0 || (source === start.source && start.output !== '');
      const later = next && compareUtf8(source, next.source) >= 0;
      if (!done && !later && !seen.has(source))
        result.limitations.push(limitation('missing_index', source, `No selected ${capability} index for this source`));
    }
    let previous: Group | undefined;
    for (const group of groups) {
      if (previous?.source === group.source && previous.order && group.order && group.order[0] <= previous.order[1]) {
        result.limitations.push(limitation('corrupt', group.source, 'Index outputs overlap in native order; later output withheld'));
        continue;
      }
      previous = group;
      const resume = group.source === start.source && group.output === start.output ? start : null;
      const stop = await this.searchGroup(session, group, capability, searchKey, resume, result);
      if (stop) return finish(result, stop, resumed);
    }
    return finish(result, next ? { source: next.source, output: next.output, order: next.order?.[0] ?? 0, dir: 0, entry: 0, after: null, anchor: null } : null, resumed);
  }

  private async searchGroup(session: ReadSession, group: Group, capability: string, key: string,
                            resume: SearchPosition | null, result: SearchResult): Promise<SearchPosition | null> {
    const order = group.order?.[0] ?? 0;
    if (group.state === 'missing' || group.state === 'unresolved' || !group.manifestId) {
      result.limitations.push(limitation('missing_index', group.source, group.limitation ?? `Index coverage is ${group.state}`));
      return null;
    }
    if (!group.order) {
      result.limitations.push(limitation('incompatible_index', group.source, 'Index has no native order range; it must be rebuilt'));
      return null;
    }
    const fresh: SearchPosition = { source: group.source, output: group.output, order, dir: 0, entry: 0, after: null, anchor: null };
    let manifest: IndexManifest;
    try {
      const loaded = await this.manifest(session, group, capability);
      if (!loaded) return resume ?? fresh;
      manifest = loaded;
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      result.limitations.push(limitation(error.state, group.source, error.message));
      return null;
    }
    if (manifest.order_range[0] !== group.order[0] || manifest.order_range[1] !== group.order[1]) {
      result.limitations.push(limitation('corrupt', group.source, 'Index manifest: order range disagrees with the D1 record'));
      return null;
    }
    const invalid = () => new ReadError('invalid_request', 'Continuation does not match the selected index; start the search again');
    const directories = candidateDirectoryPages(manifest, key);
    const files = [...manifest.postings.keys()];
    // `last`/`lastPage`: the last delivered occurrence and the postings page holding it.
    let last = resume?.after ?? null;
    let lastPage: PageRef | null = resume?.anchor ?? null;
    const stopAt = (dir: number, entry: number): SearchPosition =>
      last && lastPage ? { ...fresh, dir, entry, after: last, anchor: lastPage } : fresh;
    let d = 0;
    let e0 = 0;
    let skipThrough: [number, string] | null = null;   // resume inside the anchor page
    if (resume?.after) {
      d = directories.indexOf(resume.dir);
      if (d < 0) throw invalid();
    }
    const scope: SearchedScope = { source_revision_id: group.source, capability, coverage_state: manifest.coverage_state,
      unit_ids: manifest.unit_ids, normalization_rule: manifest.normalization_rule, complete: false, resumed_after: resume?.after ?? null };
    result.searched.push(scope);
    if (manifest.coverage_state !== 'available')
      result.limitations.push(limitation('missing_index', group.source, manifest.coverage_limitation ?? `Index coverage is ${manifest.coverage_state}`));
    const withhold = (state: ReadError['state'], detail: string) => {
      result.limitations.push(limitation(state, group.source, `${detail}; the rest of this index output was not searched`));
      return null;
    };
    const readPage = async (ref: PageRef) => {
      const text = await readArtifact(session, manifest.postings.get(ref.file)!, { offset: ref.offset, length: ref.length, sha256: ref.sha256 });
      if (!text.endsWith('\n')) throw new ReadError('corrupt', 'Index page is not line-aligned');
      return text;
    };
    for (; d < directories.length; d++) {
      const dir = directories[d];
      let entries: DirectoryEntry[] | null;
      try { entries = await this.directoryPage(session, manifest, dir); }
      catch (error) { if (!(error instanceof ReadError)) throw error; return withhold(error.state, error.message); }
      if (!entries) return stopAt(dir, 0);
      let e = 0;
      if (resume?.after && dir === resume.dir) {
        // The next page must follow the anchor page byte for byte (or be the anchor page itself),
        // and the anchor page must hold the exact last delivered occurrence.
        const anchor = resume.anchor!;
        const next = entries[resume.entry];
        if (!next || !manifest.postings.has(anchor.file)) throw invalid();
        const anchorFile = manifest.postings.get(anchor.file)!;
        const inside = next.postings_artifact_id === anchor.file && next.byte_offset === anchor.offset
          && next.byte_length === anchor.length && next.sha256 === anchor.sha256;
        const follows = next.postings_artifact_id === anchor.file ? next.byte_offset === anchor.offset + anchor.length
          : anchor.offset + anchor.length === anchorFile.byte_count && next.byte_offset === 0
            && files.indexOf(next.postings_artifact_id) === files.indexOf(anchor.file) + 1;
        if ((!inside && !follows) || anchor.offset + anchor.length > anchorFile.byte_count || anchor.length > manifest.page_cap) throw invalid();
        if (inside) skipThrough = resume.after;
        else {
          if (!session.budget.canRead(anchor.length)) return stopAt(dir, resume.entry);
          let text: string;
          try { text = await readPage(anchor); }
          catch (error) { if (!(error instanceof ReadError)) throw error; throw error.state === 'corrupt' ? invalid() : error; }
          const holds = text.slice(0, -1).split('\n').some(line => {
            try { const p = JSON.parse(line); return p.search_key === key && p.native_order === resume.after![0] && p.occurrence_id === resume.after![1]; }
            catch { return false; }
          });
          if (!holds) throw invalid();
        }
        e = resume.entry;
        e0 = e;
      }
      for (; e < entries.length; e++) {
        const entry = entries[e];
        if (!entryOverlaps(entry, key)) continue;
        if (!session.budget.canRead(entry.byte_length)) return stopAt(dir, e);
        const ref: PageRef = { file: entry.postings_artifact_id, offset: entry.byte_offset, length: entry.byte_length, sha256: entry.sha256 };
        let text: string;
        try { text = await readPage(ref); }
        catch (error) { if (!(error instanceof ReadError)) throw error; return withhold(error.state, error.message); }
        let anchorSeen = false;
        const anchorPage = skipThrough !== null && dir === resume?.dir && e === e0;
        for (const line of text.slice(0, -1).split('\n')) {
          let posting: Record<string, unknown>;
          try { posting = JSON.parse(line); } catch { return withhold('corrupt', 'Unreadable posting'); }
          if (posting.search_key !== key) continue;
          const hit = checkPosting(posting, group.source, manifest);
          if (!hit) return withhold('corrupt', 'Inconsistent posting');
          const position: [number, string] = [hit.native_order, hit.occurrence_id];
          if (anchorPage && skipThrough) {
            if (position[0] === skipThrough[0] && position[1] === skipThrough[1]) { anchorSeen = true; continue; }
            if (notAfter(position, skipThrough)) continue;
            if (!anchorSeen) throw invalid();
            skipThrough = null;
          }
          if (last && notAfter(position, last)) return withhold('corrupt', 'Postings out of order');
          const bytes = hitBytes(hit);
          if (!session.budget.canReturn(bytes)) return stopAt(dir, e);
          session.budget.spendResult(bytes);
          result.hits.push(hit);
          last = position;
          lastPage = ref;
        }
        if (anchorPage && skipThrough) {    // the whole anchor page was delivered before
          if (!anchorSeen) throw invalid();
          skipThrough = null;
        }
      }
    }
    scope.complete = true;
    return null;
  }

  private async manifest(session: ReadSession, group: Group, capability: string): Promise<IndexManifest | null> {
    const artifact = group.artifacts.get(group.manifestId!);
    if (!artifact || artifact.format !== 'application/json') throw new ReadError('corrupt', 'Index manifest is not registered for this output');
    const key = canonicalJson([session.release.id, group.source, group.output, artifact.id, artifact.sha256, artifact.format, group.method, capability]);
    const cached = MANIFESTS.get(key);
    if (cached) return cached;
    // Forward progress on a cold isolate: the manifest, one directory page, the re-read anchor
    // page and one new page must fit one request, or every cold request would end where it started.
    const { r2Bytes, r2Reads, pageBytes } = session.budget.limits;
    if (artifact.byte_count > pageBytes || artifact.byte_count + 3 * pageBytes > r2Bytes || r2Reads < 4)
      throw new ReadError('exceeds_limits', 'Index manifest is too large to search within one request allowance');
    if (!session.budget.canRead(artifact.byte_count, 'object')) return null;
    const raw = await readArtifact(session, artifact);
    const manifest = checkManifest(raw, { output: group.output, source: group.source, capability, state: group.state, pageCap: pageBytes }, group.artifacts);
    remember(MANIFESTS, key, manifest);
    return manifest;
  }

  private async directoryPage(session: ReadSession, manifest: IndexManifest, index: number): Promise<DirectoryEntry[] | null> {
    const root = manifest.directory.pages[index];
    const artifact = manifest.directory.artifact;
    const key = canonicalJson([session.release.id, artifact.id, artifact.sha256, root.byte_offset, root.byte_length, root.sha256]);
    const cached = DIRECTORY_PAGES.get(key);
    if (cached) return cached;
    if (!session.budget.canRead(root.byte_length)) return null;
    const entries = directoryEntries(manifest, root, await readArtifact(session, artifact,
      { offset: root.byte_offset, length: root.byte_length, sha256: root.sha256 }));
    remember(DIRECTORY_PAGES, key, entries);
    return entries;
  }
}

function groupRows(rows: Record<string, unknown>[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.source !== row.source_revision_id || group.output !== row.output_id) {
      const first = row.order_first, lastOrder = row.order_last;
      group = { source: String(row.source_revision_id), output: String(row.output_id), state: String(row.state),
        limitation: typeof row.limitation === 'string' ? row.limitation : null, method: String(row.method_version),
        manifestId: typeof row.index_artifact_id === 'string' ? row.index_artifact_id : null,
        order: isSafeCount(first) && isSafeCount(lastOrder) && first <= lastOrder ? [first, lastOrder] : null, artifacts: new Map() };
      groups.push(group);
    }
    if (row.artifact_id !== null && row.artifact_id !== undefined) {
      const artifact = artifactFrom({ id: row.artifact_id, sha256: row.sha256, byte_count: row.byte_count, format: row.format, registered_locator: row.registered_locator });
      group.artifacts.set(artifact.id, artifact);
    }
  }
  return groups;
}

function checkPosting(p: Record<string, unknown>, source: string, manifest: IndexManifest): SearchHit | null {
  const ref = p.native_reference as SearchHit['native_reference'] | undefined;
  const expectedKind = manifest.index_kind === 'source_text' ? 'source' : 'word';
  if (p.posting_kind !== expectedKind || p.source_revision_id !== source || !isIdentifier(p.span_id) || !isIdentifier(p.occurrence_id)
      || !isSafeCount(p.native_order) || p.coordinate_version !== manifest.coordinate_version || !ref || ref.schema_version !== 'native-reference/1'
      || ref.source_revision_id !== p.source_revision_id || ref.coordinate_version !== p.coordinate_version || !Array.isArray(ref.segments) || ref.segments.length < 1)
    return null;
  const hit: SearchHit = { source_revision_id: source, span_id: p.span_id, coordinate_version: p.coordinate_version as string,
    native_order: p.native_order, occurrence_id: p.occurrence_id, native_reference: ref };
  if (expectedKind === 'word') {
    if (typeof p.form !== 'string' || !Array.isArray(p.analyses)) return null;
    hit.form = p.form;
    hit.analyses = p.analyses;   // competing analyses stay separate and attributed
  }
  return hit;
}

const notAfter = (order: [number, string], than: [number, string]) =>
  order[0] < than[0] || (order[0] === than[0] && compareUtf8(order[1], than[1]) <= 0);

/** The size a hit adds to the batch, as the batch layer wraps it. One owner charges it. */
export function hitBytes(hit: SearchHit): number { return utf8Length(canonicalJson({ kind: 'search_hit', hit })) + 1; }

/** `no_match` only for a search started from the beginning; a resumed search that ends without
 *  new hits is `complete`, because earlier batches delivered its matches. */
function finish(result: SearchResult, remaining: SearchPosition | null, resumed: boolean): SearchResult {
  result.remaining = remaining;
  if (remaining) result.state = 'continues';
  else if (result.limitations.length) result.state = 'incomplete';
  else result.state = result.hits.length || resumed ? 'complete' : 'no_match';
  return result;
}
