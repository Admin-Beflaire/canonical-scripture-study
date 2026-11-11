import { canonicalJson, compareUtf8, isIdentifier, isSafeCount, utf8Length } from './bytes.ts';
import { candidatePages, checkManifest, type IndexManifest } from './manifest.ts';
import { artifactFrom, readArtifact, type RegisteredArtifact } from './objects.ts';
import type { ReadSession } from './session.ts';
import { ReadError, limitation, type Limitation } from './states.ts';

/** Source-scoped search contract used by Study operators. Only the adapter knows the
 *  index format, object layout and page directory; operators see attributed native
 *  references, searched scope, coverage, limitations and a remaining position. */
export type LookupKind = 'word' | 'lemma' | 'form' | 'grammar' | 'phrase' | 'proximity' | 'fuzzy';
export const SUPPORTED_LOOKUPS: readonly LookupKind[] = ['word', 'lemma', 'form', 'grammar'];
export const UNSUPPORTED_LOOKUPS: readonly LookupKind[] = ['phrase', 'proximity', 'fuzzy'];

/** Opaque to operators; carried inside a validated continuation. */
export interface SearchPosition { source: string; output: string; file: number; page: number; after: [number, string] | null }

export interface SearchRequest { lookup: string; key: string; sources: string[]; position?: SearchPosition | null }

export interface SearchHit {
  source_revision_id: string; span_id: string; coordinate_version: string; native_order: number; occurrence_id: string;
  native_reference: { schema_version: string; source_revision_id: string; coordinate_version: string; segments: { unit_id: string; start: number; end: number }[] };
  form?: string; analyses?: unknown[];
}

export interface SearchedScope {
  source_revision_id: string; capability: string; coverage_state: string; unit_ids: string[];
  normalization_rule: string; complete: boolean;
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
      && (position.output === '' ? position.file === 0 && position.page === 0 && position.after === null : isIdentifier(position.output))
      && isSafeCount(position.file) && isSafeCount(position.page)
      && (position.after === null || (Array.isArray(position.after) && position.after.length === 2
        && isSafeCount(position.after[0]) && isIdentifier(position.after[1])));
    if (!ok) throw new ReadError('invalid_request', 'Invalid search position');
  }
  return { lookup: request.lookup, key: request.key, sources: [...sources].sort(compareUtf8), position };
}

interface Group { source: string; output: string; state: string; limitation: string | null; method: string;
  manifestId: string | null; artifacts: Map<string, RegisteredArtifact> }

/** Verified manifests of selected immutable outputs, per isolate. The key carries the release,
 *  source, output, manifest artifact and digest, format and processing basis; an entry is only
 *  consulted after this request's D1 read has confirmed the artifact is selected now. */
const MANIFESTS = new Map<string, IndexManifest>();
const MANIFEST_CACHE_ENTRIES = 32;
export function clearSearchCache() { MANIFESTS.clear(); }
export function searchCacheSize() { return MANIFESTS.size; }

/** Reads only the D1 rows and R2 pages needed for one exact key, in deterministic order:
 *  source revision, index output, then (native order, occurrence ID) within the output. */
export class PagedIndexSearch implements SearchAdapter {
  async search(session: ReadSession, input: SearchRequest): Promise<SearchResult> {
    const request = checkRequest(input);
    const result: SearchResult = { state: 'complete', lookup: request.lookup, key: request.key, hits: [], searched: [], limitations: [], remaining: null, ranked: false };
    if (UNSUPPORTED_LOOKUPS.includes(request.lookup as LookupKind)) {
      result.state = 'unsupported_capability';
      result.limitations.push(limitation('unsupported_capability', request.lookup, `${request.lookup} search is not offered by the current indexes; nothing was searched`));
      return result;
    }
    const capability = CAPABILITY[request.lookup];
    const searchKey = request.lookup === 'word' ? request.key : `${request.lookup}:${request.key}`;
    const start = request.position ?? { source: request.sources[0], output: '', file: 0, page: 0, after: null };
    if (!session.canQuery()) return finish(result, start);
    const { rows, more } = await session.query('index_files', { source_revision_ids: request.sources, capability, after: [start.source, start.output] });
    const groups = groupRows(rows);
    let next: Group | undefined;
    if (more) {
      next = groups.pop();
      if (!next) throw new ReadError('exceeds_limits', 'One index output has more registered files than a query may return');
    }
    const seen = new Set(groups.map(g => g.source));
    for (const source of request.sources) {
      // Sources before the resume point, or a resumed source past its first output, were reported earlier.
      const done = compareUtf8(source, start.source) < 0 || (source === start.source && start.output !== '');
      const later = next && compareUtf8(source, next.source) >= 0;
      if (!done && !later && !seen.has(source))
        result.limitations.push(limitation('missing_index', source, `No selected ${capability} index for this source`));
    }
    for (const group of groups) {
      const resume = group.source === start.source && group.output === start.output ? start : null;
      const stop = await this.searchGroup(session, group, capability, searchKey, resume, result);
      if (stop) return finish(result, stop);
    }
    return finish(result, next ? { source: next.source, output: next.output, file: 0, page: 0, after: null } : null);
  }

  private async searchGroup(session: ReadSession, group: Group, capability: string, key: string,
                            resume: SearchPosition | null, result: SearchResult): Promise<SearchPosition | null> {
    const at = (file: number, page: number, after: [number, string] | null): SearchPosition => ({ source: group.source, output: group.output, file, page, after });
    if (group.state === 'missing' || group.state === 'unresolved' || !group.manifestId) {
      result.limitations.push(limitation('missing_index', group.source, group.limitation ?? `Index coverage is ${group.state}`));
      return null;
    }
    let manifest: IndexManifest;
    try {
      const loaded = await this.manifest(session, group, capability);
      if (!loaded) return at(resume?.file ?? 0, resume?.page ?? 0, resume?.after ?? null);
      manifest = loaded;
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      result.limitations.push(limitation(error.state, group.source, error.message));
      return null;
    }
    const candidates = candidatePages(manifest, key);
    let index = 0;
    let skipThrough = resume?.after ?? null;   // delivered before this request
    let last = skipThrough;                     // postings must keep strictly increasing order
    if (resume && (resume.file !== 0 || resume.page !== 0 || skipThrough !== null)) {
      index = candidates.findIndex(c => c.file === resume.file && c.page === resume.page);
      if (index < 0) throw new ReadError('invalid_request', 'Search position does not match the selected index');
    }
    const scope: SearchedScope = { source_revision_id: group.source, capability, coverage_state: manifest.coverage_state,
      unit_ids: manifest.unit_ids, normalization_rule: manifest.normalization_rule, complete: false };
    result.searched.push(scope);
    if (manifest.coverage_state !== 'available')
      result.limitations.push(limitation('missing_index', group.source, manifest.coverage_limitation ?? `Index coverage is ${manifest.coverage_state}`));
    for (; index < candidates.length; index++) {
      const { file, page } = candidates[index];
      const entry = manifest.files[file].pages[page];
      if (!session.budget.canRead(entry.byte_length)) return at(file, page, last);
      let text: string;
      try {
        text = await readArtifact(session, manifest.files[file].artifact, { offset: entry.byte_offset, length: entry.byte_length, sha256: entry.sha256 });
        if (!text.endsWith('\n')) throw new ReadError('corrupt', 'Index page is not line-aligned');
      } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        result.limitations.push(limitation(error.state, group.source, `${error.message}; the rest of this index output was not searched`));
        return null;
      }
      for (const line of text.slice(0, -1).split('\n')) {
        let posting: Record<string, unknown>;
        try { posting = JSON.parse(line); } catch { result.limitations.push(limitation('corrupt', group.source, 'Unreadable posting; index output withheld')); return null; }
        if (posting.search_key !== key) continue;
        const hit = checkPosting(posting, group.source, manifest);
        if (!hit) { result.limitations.push(limitation('corrupt', group.source, 'Inconsistent posting; index output withheld')); return null; }
        const order: [number, string] = [hit.native_order, hit.occurrence_id];
        if (skipThrough && notAfter(order, skipThrough)) continue;
        skipThrough = null;
        if (last && notAfter(order, last)) {
          result.limitations.push(limitation('corrupt', group.source, 'Postings out of order; index output withheld'));
          return null;
        }
        const bytes = utf8Length(canonicalJson(hit));
        if (!session.budget.canReturn(bytes)) return at(file, page, last);
        session.budget.spendResult(bytes);
        result.hits.push(hit);
        last = order;
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
    if (!session.budget.canRead(artifact.byte_count, 'object')) {
      if (artifact.byte_count > session.budget.limits.r2Bytes) throw new ReadError('exceeds_limits', 'Index manifest is larger than the request allowance');
      return null;
    }
    const raw = await readArtifact(session, artifact);
    const manifest = checkManifest(raw, { output: group.output, source: group.source, capability, state: group.state, pageCap: session.budget.limits.pageBytes }, group.artifacts);
    if (MANIFESTS.size >= MANIFEST_CACHE_ENTRIES) MANIFESTS.delete(MANIFESTS.keys().next().value!);
    MANIFESTS.set(key, manifest);
    return manifest;
  }
}

function groupRows(rows: Record<string, unknown>[]): Group[] {
  const groups: Group[] = [];
  for (const row of rows) {
    let group = groups.at(-1);
    if (!group || group.source !== row.source_revision_id || group.output !== row.output_id) {
      group = { source: String(row.source_revision_id), output: String(row.output_id), state: String(row.state),
        limitation: typeof row.limitation === 'string' ? row.limitation : null, method: String(row.method_version),
        manifestId: typeof row.index_artifact_id === 'string' ? row.index_artifact_id : null, artifacts: new Map() };
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

function finish(result: SearchResult, remaining: SearchPosition | null): SearchResult {
  result.remaining = remaining;
  if (remaining) result.state = 'continues';
  else if (result.limitations.length) result.state = 'incomplete';
  else result.state = result.hits.length ? 'complete' : 'no_match';
  return result;
}
