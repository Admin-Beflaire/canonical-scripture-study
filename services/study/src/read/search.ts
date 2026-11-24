import {
  canonicalJson,
  compareUtf8,
  isIdentifier,
  isSafeCount,
  utf8Length,
} from './bytes.ts';
import {
  candidateDirectoryPages,
  checkManifest,
  directoryEntries,
  entryOverlaps,
  type DirectoryEntry,
  type IndexManifest,
} from './manifest.ts';
import {
  artifactFrom,
  readArtifact,
  type RegisteredArtifact,
} from './objects.ts';
import type {ReadSession} from './session.ts';
import type {IndexFilesInput} from './queries.ts';
import {ReadError, limitation, type Limitation} from './states.ts';

/** Source-scoped search contract used by Study operators. Only the adapter knows the
 *  index format, object layout and page directory; operators see attributed native
 *  references, searched scope, coverage, limitations and a remaining position. */
export type LookupKind =
  'word' | 'lemma' | 'form' | 'grammar' | 'phrase' | 'proximity' | 'fuzzy';
export const SUPPORTED_LOOKUPS: readonly LookupKind[] = [
  'word',
  'lemma',
  'form',
  'grammar',
];
export const UNSUPPORTED_LOOKUPS: readonly LookupKind[] = [
  'phrase',
  'proximity',
  'fuzzy',
];

/** Opaque to operators; carried inside a validated continuation. `order` is the output's
 *  `order_range` start; `dir`/`entry` name the directory entry of the next postings page to read;
 *  `anchor` is the postings page holding `after`, the last delivered occurrence. */
export interface PageRef {
  file: string;
  offset: number;
  length: number;
  sha256: string;
}
export interface SearchPosition {
  source: string;
  output: string;
  order: number;
  dir: number;
  entry: number;
  after: [number, string] | null;
  anchor: PageRef | null;
}

export interface SearchRequest {
  lookup: string;
  key: string;
  sources: string[];
  position?: SearchPosition | null;
}

export interface SearchHit {
  source_revision_id: string;
  span_id: string;
  coordinate_version: string;
  native_order: number;
  occurrence_id: string;
  native_reference: {
    schema_version: string;
    source_revision_id: string;
    coordinate_version: string;
    segments: {unit_id: string; start: number; end: number}[];
  };
  form?: string;
  analyses?: unknown[];
  /** Selected evidence shared by occurrences with the same lemma and morphology. */
  aid_matches?: Array<{
    analysis_id: string;
    lexicon: string[];
    grammar: string[];
    proper_name?: string[];
  }>;
}

/** What this request searched. `complete` covers the stated extent from `resumed_after`
 *  (exclusive) onwards; occurrences up to it were delivered by earlier batches. */
export interface SearchedScope {
  source_revision_id: string;
  capability: string;
  coverage_state: string;
  /** The output's contiguous native extent: unit count, first and last unit, linear order range. */
  unit_count: number;
  first_unit: string;
  last_unit: string;
  order_range: [number, number];
  normalization_rule: string;
  complete: boolean;
  resumed_after: [number, string] | null;
  /** Source-wide selected-index coverage; not a claim that R2 pages were opened. */
  routing_summary?: true;
}

/** `complete`: every selected candidate page was read and no gaps were found.
 *  `no_match`: complete, and nothing matched in the stated extent.
 *  `incomplete`: finished, but some extent had a missing index, corruption or failure (see limitations).
 *  `continues`: the allowance ran out; resume from `remaining`.
 *  `unsupported_capability`: the lookup kind is not offered; nothing was searched. */
export type SearchState =
  | 'complete'
  | 'no_match'
  | 'incomplete'
  | 'continues'
  | 'unsupported_capability';

export interface SearchResult {
  state: SearchState;
  lookup: string;
  key: string;
  hits: SearchHit[];
  searched: SearchedScope[];
  limitations: Limitation[];
  remaining: SearchPosition | null;
  ranked: false;
  /** For each hit, the position that resumes directly after it, so a caller can deliver fewer hits
   *  and still continue exactly. Same length as `hits`. */
  resume_after: SearchPosition[];
}

export interface SearchAdapter {
  search(session: ReadSession, request: SearchRequest): Promise<SearchResult>;
}

const CAPABILITY: Record<string, string> = {
  word: 'word_exact',
  lemma: 'lemma_exact',
  form: 'form_exact',
  grammar: 'grammar_exact',
};

/** An anchor is verified against its actual posting page before any resume. */
function validPageAnchor(raw: unknown): raw is PageRef {
  if (!raw || typeof raw !== 'object') return false;
  const anchor = raw as PageRef;
  return isIdentifier(anchor.file) && isSafeCount(anchor.offset) &&
    isSafeCount(anchor.length) && anchor.length > 0 &&
    typeof anchor.sha256 === 'string' && /^[0-9a-f]{64}$/.test(anchor.sha256);
}

function validSearchAfter(pos: SearchPosition): boolean {
  if (pos.after === null)
    return pos.dir === 0 && pos.entry === 0 && pos.anchor === null;
  return validPageAnchor(pos.anchor) && Array.isArray(pos.after) &&
    pos.after.length === 2 && isSafeCount(pos.after[0]) &&
    isIdentifier(pos.after[1]);
}

function validPosition(pos: SearchPosition, sources: string[]): boolean {
  if (!pos || typeof pos !== 'object' || !sources.includes(pos.source))
    return false;
  const root = pos.output === ''
    ? pos.order === 0 && pos.dir === 0 && pos.entry === 0 && pos.after === null
    : isIdentifier(pos.output);
  return root && isSafeCount(pos.order) && isSafeCount(pos.dir) &&
    isSafeCount(pos.entry) && validSearchAfter(pos);
}

function checkedSources(sources: unknown): string[] {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 20 ||
      !sources.every(s => isIdentifier(s)) ||
      new Set(sources).size !== sources.length)
    throw new ReadError('invalid_request', 'Expected a short list of distinct source revisions');
  return sources as string[];
}

/** Normalises and checks a request. Unknown kinds are invalid; known unsupported kinds are explicit. */
export function checkRequest(request: SearchRequest): SearchRequest {
  if (!request || typeof request !== 'object')
    throw new ReadError('invalid_request', 'Missing search request');
  if (![...SUPPORTED_LOOKUPS, ...UNSUPPORTED_LOOKUPS].includes(request.lookup as LookupKind))
    throw new ReadError('invalid_request', 'Unknown lookup kind');
  if (typeof request.key !== 'string' || request.key.length < 1 ||
      request.key.length > 256 || /[\uD800-\uDFFF]/u.test(request.key))
    throw new ReadError('invalid_request', 'Invalid search key');
  const sources = checkedSources(request.sources);
  const position = request.position ?? null;
  if (position !== null && !validPosition(position, sources))
    throw new ReadError('invalid_request', 'Invalid search position');
  return {lookup: request.lookup, key: request.key, sources: [...sources].sort(compareUtf8), position};
}

interface Group {
  source: string;
  output: string;
  state: string;
  limitation: string | null;
  method: string;
  manifestId: string | null;
  order: [number, number] | null;
  routed: boolean;
  artifacts: Map<string, RegisteredArtifact>;
}

/** Verified manifests and directory pages of selected immutable outputs, per isolate. Keys carry
 *  the release, source, output, artifact and digest, format and processing basis; an entry is only
 *  consulted after this request's D1 read has confirmed the artifact is selected now. */
const MANIFESTS = new Map<string, IndexManifest>();
const DIRECTORY_PAGES = new Map<string, DirectoryEntry[]>();
const CACHE_ENTRIES = 64;
export function clearSearchCache() {
  MANIFESTS.clear();
  DIRECTORY_PAGES.clear();
}
export function searchCacheSize() {
  return MANIFESTS.size + DIRECTORY_PAGES.size;
}
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

interface SourceExtent {
  state: string;
  first: number;
  last: number;
  first_unit: string;
  last_unit: string;
  units: number;
  rule: string | null;
  skipped: number;
}

/** The selected index can prove a key absent without opening any R2 page. */
function coverageSummary(
  row: Record<string, unknown>,
  capability: string,
): SearchedScope {
  let extents: SourceExtent[];
  try {
    extents = JSON.parse(String(row.extents)) as SourceExtent[];
  } catch {
    throw new ReadError('corrupt', 'Invalid selected index coverage');
  }
  if (!Array.isArray(extents) || !extents.length || extents.some(e =>
    !isSafeCount(e.first) || !isSafeCount(e.last) ||
    typeof e.first_unit !== 'string' || typeof e.last_unit !== 'string' ||
    !isSafeCount(e.units) || (e.rule !== null && typeof e.rule !== 'string')))
    throw new ReadError('corrupt', 'Invalid selected index coverage');
  extents.sort((a, b) => a.first - b.first);
  return {
    source_revision_id: String(row.source_revision_id),
    capability,
    coverage_state: extents.every(e => e.state === 'available') ? 'available' : 'partial',
    unit_count: extents.reduce((n, e) => n + e.units, 0),
    first_unit: extents[0].first_unit,
    last_unit: extents.at(-1)!.last_unit,
    order_range: [extents[0].first, Math.max(...extents.map(e => e.last))],
    normalization_rule: extents[0].rule ?? 'not recorded',
    complete: true,
    resumed_after: null,
    routing_summary: true,
  };
}

interface ScanState {
  fresh: SearchPosition;
  last: [number, string] | null;
  lastPage: PageRef | null;
  skipThrough: [number, string] | null;
  resumeEntry: number;
}
type ScanOutcome = SearchPosition | 'withheld' | null;

const invalidContinuation = () =>
  new ReadError('invalid_request', 'Continuation does not match the selected index; start the search again');

function stopAt(state: ScanState, dir: number, entry: number): SearchPosition {
  return state.last && state.lastPage
    ? {...state.fresh, dir, entry, after: state.last, anchor: state.lastPage}
    : state.fresh;
}

function withholdIndex(
  result: SearchResult, group: Group, state: ReadError['state'], detail: string,
): 'withheld' {
  result.limitations.push(limitation(
    state, group.source, `${detail}; the rest of this index output was not searched`,
  ));
  return 'withheld';
}

async function readPostingsPage(
  session: ReadSession, manifest: IndexManifest, ref: PageRef,
): Promise<string> {
  const text = await readArtifact(session, manifest.postings.get(ref.file)!, {
    offset: ref.offset, length: ref.length, sha256: ref.sha256,
  });
  if (!text.endsWith('\n')) throw new ReadError('corrupt', 'Index page is not line-aligned');
  return text;
}

function anchorFollows(
  entries: DirectoryEntry[], resume: SearchPosition, manifest: IndexManifest,
): boolean {
  const anchor = resume.anchor!;
  const next = entries[resume.entry];
  if (!next || !manifest.postings.has(anchor.file)) return false;
  const file = manifest.postings.get(anchor.file)!;
  const inside = next.postings_artifact_id === anchor.file &&
    next.byte_offset === anchor.offset && next.byte_length === anchor.length &&
    next.sha256 === anchor.sha256;
  const files = [...manifest.postings.keys()];
  const follows = next.postings_artifact_id === anchor.file
    ? next.byte_offset === anchor.offset + anchor.length
    : anchor.offset + anchor.length === file.byte_count && next.byte_offset === 0 &&
      files.indexOf(next.postings_artifact_id) === files.indexOf(anchor.file) + 1;
  return (inside || follows) && anchor.offset + anchor.length <= file.byte_count &&
    anchor.length <= manifest.page_cap;
}

function anchorIsInside(
  next: DirectoryEntry, anchor: PageRef,
): boolean {
  return next.postings_artifact_id === anchor.file && next.byte_offset === anchor.offset &&
    next.byte_length === anchor.length && next.sha256 === anchor.sha256;
}

function containsLastDelivered(text: string, key: string, after: [number, string]): boolean {
  return text.slice(0, -1).split('\n').some(line => {
    try {
      const p = JSON.parse(line);
      return p.search_key === key && p.native_order === after[0] &&
        p.occurrence_id === after[1];
    } catch {
      return false;
    }
  });
}

function anchorPosition(
  position: [number, string], through: [number, string], anchorSeen: boolean,
): 'anchor' | 'before' | 'after' {
  if (position[0] === through[0] && position[1] === through[1]) return 'anchor';
  if (notAfter(position, through)) return 'before';
  if (!anchorSeen) throw invalidContinuation();
  return 'after';
}

function groupScope(
  group: Group, manifest: IndexManifest, capability: string,
  resume: SearchPosition | null,
): SearchedScope {
  return {
    source_revision_id: group.source, capability,
    coverage_state: manifest.coverage_state,
    unit_count: manifest.unit_ids.length,
    first_unit: manifest.unit_ids[0], last_unit: manifest.unit_ids.at(-1)!,
    order_range: manifest.order_range,
    normalization_rule: manifest.normalization_rule,
    complete: false,
    resumed_after: resume?.after ?? null,
  };
}

/** Reads only the D1 rows and R2 pages needed for one exact key, in deterministic order:
 *  source revision, index output by `order_range`, then (native order, occurrence ID). */
export class PagedIndexSearch implements SearchAdapter {
  async search(
    session: ReadSession,
    input: SearchRequest,
  ): Promise<SearchResult> {
    const request = checkRequest(input);
    const result: SearchResult = {
      state: 'complete',
      lookup: request.lookup,
      key: request.key,
      hits: [],
      searched: [],
      limitations: [],
      remaining: null,
      ranked: false,
      resume_after: [],
    };
    if (UNSUPPORTED_LOOKUPS.includes(request.lookup as LookupKind)) {
      result.state = 'unsupported_capability';
      result.limitations.push(limitation(
        'unsupported_capability', request.lookup,
        `${request.lookup} search is not offered by the current indexes; nothing was searched`,
      ));
      return result;
    }
    const resumed = request.position !== null;
    const capability = CAPABILITY[request.lookup];
    const searchKey = request.lookup === 'word' ? request.key : `${request.lookup}:${request.key}`;
    const start: SearchPosition = request.position ?? {
      source: request.sources[0], output: '', order: 0,
      dir: 0, entry: 0, after: null, anchor: null,
    };
    const selected = await this.selectGroups(session, request, start, capability, searchKey);
    if (!selected) return finish(result, start, resumed);
    if (!await this.recordCoverage(
      session, request, start, selected.groups, selected.next, capability, searchKey, result,
    )) return finish(result, start, resumed);
    const stop = await this.scanGroups(
      session, selected.groups, start, capability, searchKey, result,
    );
    if (stop) return finish(result, stop, resumed);
    const next = selected.next;
    return finish(result, next ? {
      source: next.source, output: next.output, order: next.order?.[0] ?? 0,
      dir: 0, entry: 0, after: null, anchor: null,
    } : null, resumed);
  }

  private async selectGroups(
    session: ReadSession, request: SearchRequest, start: SearchPosition,
    capability: string, key: string,
  ): Promise<{groups: Group[]; next?: Group} | null> {
    const indexInput: IndexFilesInput = {
      source_revision_ids: request.sources, capability, key,
      after: [start.source, start.output === '' ? -1 : start.order, start.output],
    };
    const indexRows = await session.queryIfAvailable('index_files', indexInput);
    if (!indexRows) return null;
    const groups = groupRows(indexRows.rows);
    let next: Group | undefined;
    if (indexRows.more) {
      if (groups.length < 2)
        throw new ReadError('exceeds_limits', 'One index output has more registered files than a query may return');
      next = groups.pop();
    }
    const anchor = groups[0] ?? next;
    if (start.output !== '' && (!anchor || anchor.source !== start.source ||
      anchor.output !== start.output || anchor.order?.[0] !== start.order))
      throw new ReadError('invalid_request', 'Continuation does not match the selected index; start the search again');
    return {groups, next};
  }

  private async recordCoverage(
    session: ReadSession, request: SearchRequest, start: SearchPosition,
    groups: Group[], next: Group | undefined, capability: string,
    key: string, result: SearchResult,
  ): Promise<boolean> {
    const sources = request.sources.filter(source =>
      !(compareUtf8(source, start.source) < 0 ||
        (source === start.source && start.output !== '')) &&
      !(next && compareUtf8(source, next.source) >= 0),
    );
    if (!sources.length) return true;
    const seen = new Set(groups.map(group => group.source));
    if (sources.every(source => seen.has(source)) && !groups.some(group => group.routed))
      return true;
    const covered = await session.queryIfAvailable('index_sources', {
      source_revision_ids: sources, capability, key,
    });
    if (!covered) return false;
    const found = new Set<string>();
    for (const row of covered.rows) {
      found.add(String(row.source_revision_id));
      let extents: SourceExtent[];
      try {
        extents = JSON.parse(String(row.extents)) as SourceExtent[];
      } catch {
        throw new ReadError('corrupt', 'Invalid selected index coverage');
      }
      if (Array.isArray(extents) && extents.some(e => e.skipped === 1))
        result.searched.push(coverageSummary(row, capability));
    }
    for (const source of sources)
      if (!found.has(source))
        result.limitations.push(limitation(
          'missing_index', source, `No selected ${capability} index for this source`,
        ));
    return true;
  }

  private async scanGroups(
    session: ReadSession, groups: Group[], start: SearchPosition,
    capability: string, key: string, result: SearchResult,
  ): Promise<SearchPosition | null> {
    let previous: Group | undefined;
    for (const group of groups) {
      if (previous?.source === group.source && previous.order && group.order &&
          group.order[0] <= previous.order[1]) {
        result.limitations.push(limitation(
          'corrupt', group.source, 'Index outputs overlap in native order; later output withheld',
        ));
        continue;
      }
      previous = group;
      const resume = group.source === start.source && group.output === start.output ? start : null;
      const stop = await this.searchGroup(session, group, capability, key, resume, result);
      if (stop) return stop;
    }
    return null;
  }

  private async searchGroup(
    session: ReadSession, group: Group, capability: string, key: string,
    resume: SearchPosition | null, result: SearchResult,
  ): Promise<SearchPosition | null> {
    const opened = await this.openGroup(session, group, capability, resume, result);
    if ('stop' in opened) return opened.stop;
    const {manifest, fresh} = opened;
    const scope = groupScope(group, manifest, capability, resume);
    result.searched.push(scope);
    if (manifest.coverage_state !== 'available')
      result.limitations.push(limitation(
        'missing_index', group.source,
        manifest.coverage_limitation ?? `Index coverage is ${manifest.coverage_state}`,
      ));
    const state: ScanState = {
      fresh, last: resume?.after ?? null, lastPage: resume?.anchor ?? null,
      skipThrough: null, resumeEntry: 0,
    };
    const stop = await this.scanDirectories(
      session, group, manifest, key, resume, state, result,
    );
    if (stop === 'withheld') return null;
    if (stop) return stop;
    scope.complete = true;
    return null;
  }

  private async openGroup(
    session: ReadSession, group: Group, capability: string,
    resume: SearchPosition | null, result: SearchResult,
  ): Promise<{manifest: IndexManifest; fresh: SearchPosition} | {stop: SearchPosition | null}> {
    if (group.state === 'missing' || group.state === 'unresolved' || !group.manifestId) {
      result.limitations.push(limitation(
        'missing_index', group.source,
        group.limitation ?? `Index coverage is ${group.state}`,
      ));
      return {stop: null};
    }
    if (!group.order) {
      result.limitations.push(limitation(
        'incompatible_index', group.source,
        'Index has no native order range; it must be rebuilt',
      ));
      return {stop: null};
    }
    const fresh: SearchPosition = {
      source: group.source, output: group.output, order: group.order[0],
      dir: 0, entry: 0, after: null, anchor: null,
    };
    let manifest: IndexManifest;
    try {
      const loaded = await this.manifest(session, group, capability);
      if (!loaded) return {stop: resume ?? fresh};
      manifest = loaded;
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      result.limitations.push(limitation(error.state, group.source, error.message));
      return {stop: null};
    }
    if (manifest.order_range[0] !== group.order[0] ||
        manifest.order_range[1] !== group.order[1]) {
      result.limitations.push(limitation(
        'corrupt', group.source,
        'Index manifest: order range disagrees with the D1 record',
      ));
      return {stop: null};
    }
    return {manifest, fresh};
  }

  private async scanDirectories(
    session: ReadSession, group: Group, manifest: IndexManifest, key: string,
    resume: SearchPosition | null, state: ScanState, result: SearchResult,
  ): Promise<ScanOutcome> {
    const directories = candidateDirectoryPages(manifest, key);
    let d = resume?.after ? directories.indexOf(resume.dir) : 0;
    if (d < 0) throw invalidContinuation();
    for (; d < directories.length; d++) {
      const dir = directories[d];
      let entries: DirectoryEntry[] | null;
      try {
        entries = await this.directoryPage(session, manifest, dir);
      } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        return withholdIndex(result, group, error.state, error.message);
      }
      if (!entries) return stopAt(state, dir, 0);
      let e = 0;
      if (resume?.after && dir === resume.dir) {
        const pending = await this.verifyAnchor(
          session, manifest, key, entries, resume, state, dir,
        );
        if (pending) return pending;
        e = resume.entry;
      }
      const stop = await this.scanEntries(
        session, group, manifest, key, entries, dir, e, resume, state, result,
      );
      if (stop) return stop;
    }
    return null;
  }

  private async verifyAnchor(
    session: ReadSession, manifest: IndexManifest, key: string,
    entries: DirectoryEntry[], resume: SearchPosition, state: ScanState, dir: number,
  ): Promise<SearchPosition | null> {
    const anchor = resume.anchor!;
    if (!anchorFollows(entries, resume, manifest)) throw invalidContinuation();
    if (anchorIsInside(entries[resume.entry], anchor))
      state.skipThrough = resume.after;
    else {
      if (!session.budget.canRead(anchor.length)) return stopAt(state, dir, resume.entry);
      let text: string;
      try {
        text = await readPostingsPage(session, manifest, anchor);
      } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        throw error.state === 'corrupt' ? invalidContinuation() : error;
      }
      if (!containsLastDelivered(text, key, resume.after!)) throw invalidContinuation();
    }
    state.resumeEntry = resume.entry;
    return null;
  }

  private async scanEntries(
    session: ReadSession, group: Group, manifest: IndexManifest, key: string,
    entries: DirectoryEntry[], dir: number, from: number,
    resume: SearchPosition | null, state: ScanState, result: SearchResult,
  ): Promise<ScanOutcome> {
    for (let e = from; e < entries.length; e++) {
      const entry = entries[e];
      if (!entryOverlaps(entry, key)) continue;
      if (!session.budget.canRead(entry.byte_length)) return stopAt(state, dir, e);
      const ref: PageRef = {
        file: entry.postings_artifact_id, offset: entry.byte_offset,
        length: entry.byte_length, sha256: entry.sha256,
      };
      let text: string;
      try {
        text = await readPostingsPage(session, manifest, ref);
      } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        return withholdIndex(result, group, error.state, error.message);
      }
      const stop = this.scanPostings(
        session, group, manifest, key, text, ref, dir, e, resume, state, result,
      );
      if (stop === 'budget') return stopAt(state, dir, e);
      if (stop === 'withheld') return stop;
    }
    return null;
  }

  private scanPostings(
    session: ReadSession, group: Group, manifest: IndexManifest, key: string,
    text: string, ref: PageRef, dir: number, entry: number,
    resume: SearchPosition | null, state: ScanState, result: SearchResult,
  ): 'budget' | 'withheld' | null {
    let anchorSeen = false;
    const anchorPage = state.skipThrough !== null &&
      dir === resume?.dir && entry === state.resumeEntry;
    for (const line of text.slice(0, -1).split('\n')) {
      let posting: Record<string, unknown>;
      try {
        posting = JSON.parse(line);
      } catch {
        return withholdIndex(result, group, 'corrupt', 'Unreadable posting');
      }
      if (posting.search_key !== key) continue;
      const hit = checkPosting(posting, group.source, manifest);
      if (!hit) return withholdIndex(result, group, 'corrupt', 'Inconsistent posting');
      const position: [number, string] = [hit.native_order, hit.occurrence_id];
      if (anchorPage && state.skipThrough) {
        const step = anchorPosition(position, state.skipThrough, anchorSeen);
        if (step === 'anchor') {
          anchorSeen = true;
          continue;
        }
        if (step === 'before') continue;
        state.skipThrough = null;
      }
      if (state.last && notAfter(position, state.last))
        return withholdIndex(result, group, 'corrupt', 'Postings out of order');
      const bytes = hitBytes(hit);
      if (!session.budget.canReturn(bytes)) return 'budget';
      session.budget.spendResult(bytes);
      result.hits.push(hit);
      state.last = position;
      state.lastPage = ref;
      result.resume_after.push({
        ...state.fresh, dir, entry, after: position, anchor: ref,
      });
    }
    if (anchorPage && state.skipThrough) {
      if (!anchorSeen) throw invalidContinuation();
      state.skipThrough = null;
    }
    return null;
  }

  private async manifest(
    session: ReadSession,
    group: Group,
    capability: string,
  ): Promise<IndexManifest | null> {
    const artifact = group.artifacts.get(group.manifestId!);
    if (!artifact || artifact.format !== 'application/json')
      throw new ReadError(
        'corrupt',
        'Index manifest is not registered for this output',
      );
    const key = canonicalJson([
      session.release.id,
      group.source,
      group.output,
      artifact.id,
      artifact.sha256,
      artifact.format,
      group.method,
      capability,
    ]);
    const cached = MANIFESTS.get(key);
    if (cached) return cached;
    // Forward progress on a cold isolate: the manifest, one directory page, the re-read anchor
    // page and one new page must fit one request, or every cold request would end where it started.
    const {r2Bytes, r2Reads, pageBytes} = session.budget.limits;
    if (
      artifact.byte_count > pageBytes ||
      artifact.byte_count + 3 * pageBytes > r2Bytes ||
      r2Reads < 4
    )
      throw new ReadError(
        'exceeds_limits',
        'Index manifest is too large to search within one request allowance',
      );
    if (!session.budget.canRead(artifact.byte_count, 'object')) return null;
    const raw = await readArtifact(session, artifact);
    const manifest = checkManifest(
      raw,
      {
        output: group.output,
        source: group.source,
        capability,
        state: group.state,
        pageCap: pageBytes,
      },
      group.artifacts,
    );
    remember(MANIFESTS, key, manifest);
    return manifest;
  }

  private async directoryPage(
    session: ReadSession,
    manifest: IndexManifest,
    index: number,
  ): Promise<DirectoryEntry[] | null> {
    const root = manifest.directory.pages[index];
    const artifact = manifest.directory.artifact;
    const key = canonicalJson([
      session.release.id,
      artifact.id,
      artifact.sha256,
      root.byte_offset,
      root.byte_length,
      root.sha256,
    ]);
    const cached = DIRECTORY_PAGES.get(key);
    if (cached) return cached;
    if (!session.budget.canRead(root.byte_length)) return null;
    const entries = directoryEntries(
      manifest,
      root,
      await readArtifact(session, artifact, {
        offset: root.byte_offset,
        length: root.byte_length,
        sha256: root.sha256,
      }),
    );
    remember(DIRECTORY_PAGES, key, entries);
    return entries;
  }
}

function groupRows(rows: Record<string, unknown>[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (
      !group ||
      group.source !== row.source_revision_id ||
      group.output !== row.output_id
    ) {
      const first = row.order_first,
        lastOrder = row.order_last;
      group = {
        source: String(row.source_revision_id),
        output: String(row.output_id),
        state: String(row.state),
        limitation: typeof row.limitation === 'string' ? row.limitation : null,
        method: String(row.method_version),
        manifestId:
          typeof row.index_artifact_id === 'string'
            ? row.index_artifact_id
            : null,
        order:
          isSafeCount(first) && isSafeCount(lastOrder) && first <= lastOrder
            ? [first, lastOrder]
            : null,
        routed: Boolean(row.routing_available),
        artifacts: new Map(),
      };
      groups.push(group);
    }
    if (row.artifact_id !== null && row.artifact_id !== undefined) {
      const artifact = artifactFrom({
        id: row.artifact_id,
        sha256: row.sha256,
        byte_count: row.byte_count,
        format: row.format,
        registered_locator: row.registered_locator,
      });
      group.artifacts.set(artifact.id, artifact);
    }
  }
  return groups;
}

function validPostingRef(
  p: Record<string, unknown>, source: string,
  manifest: IndexManifest, ref: SearchHit['native_reference'] | undefined,
  expectedKind: string,
): ref is SearchHit['native_reference'] {
  return p.posting_kind === expectedKind && p.source_revision_id === source &&
    isIdentifier(p.span_id) && isIdentifier(p.occurrence_id) &&
    isSafeCount(p.native_order) && p.coordinate_version === manifest.coordinate_version &&
    !!ref && ref.schema_version === 'native-reference/1' &&
    ref.source_revision_id === p.source_revision_id &&
    ref.coordinate_version === p.coordinate_version &&
    Array.isArray(ref.segments) && ref.segments.length > 0;
}

function checkPosting(
  p: Record<string, unknown>,
  source: string,
  manifest: IndexManifest,
): SearchHit | null {
  const ref = p.native_reference as SearchHit['native_reference'] | undefined;
  const expectedKind =
    manifest.index_kind === 'source_text' ? 'source' : 'word';
  if (!validPostingRef(p, source, manifest, ref, expectedKind)) return null;
  const hit: SearchHit = {
    source_revision_id: source,
    span_id: p.span_id,
    coordinate_version: p.coordinate_version as string,
    native_order: p.native_order,
    occurrence_id: p.occurrence_id,
    native_reference: ref,
  };
  if (expectedKind === 'word') {
    if (typeof p.form !== 'string' || !Array.isArray(p.analyses)) return null;
    hit.form = p.form;
    hit.analyses = p.analyses; // competing analyses stay separate and attributed
  }
  return hit;
}

const notAfter = (order: [number, string], than: [number, string]) =>
  order[0] < than[0] ||
  (order[0] === than[0] && compareUtf8(order[1], than[1]) <= 0);

/** The size a hit adds to the batch, as the batch layer wraps it. One owner charges it. */
export function hitBytes(hit: SearchHit): number {
  return utf8Length(canonicalJson({kind: 'search_hit', hit})) + 1;
}

/** `no_match` only for a search started from the beginning; a resumed search that ends without
 *  new hits is `complete`, because earlier batches delivered its matches. */
function finish(
  result: SearchResult,
  remaining: SearchPosition | null,
  resumed: boolean,
): SearchResult {
  result.remaining = remaining;
  if (remaining) result.state = 'continues';
  else if (result.limitations.length) result.state = 'incomplete';
  else result.state = result.hits.length || resumed ? 'complete' : 'no_match';
  return result;
}
