import { compareUtf8, isIdentifier, isSafeCount } from './bytes.ts';
import type { RegisteredArtifact } from './objects.ts';
import { ReadError } from './states.ts';

/** `index-manifest/2` (Data Indexes To-Be 0.6 §2): the manifest lists directory pages; a paged
 *  directory artifact lists postings pages by registered postings artifact ID. */
export const MANIFEST_VERSION = 'index-manifest/2';
export const POSTINGS_FORMAT = 'application/x-ndjson';
export const DIRECTORY_FORMAT = 'application/x-ndjson; profile=index-directory';

export interface IndexPage { first_key: string; last_key: string; byte_offset: number; byte_length: number; sha256: string }
export interface DirectoryEntry extends IndexPage { postings_artifact_id: string }
export interface IndexManifest {
  index_kind: 'source_text' | 'word_language'; prepared_output_id: string; source_revision_ids: string[];
  unit_ids: string[]; order_range: [number, number]; coordinate_version: string; normalization_rule: string; tokenizer_version: string;
  capabilities: string[]; coverage_state: string; coverage_limitation: string | null; page_cap: number;
  postings: ReadonlyMap<string, RegisteredArtifact>; directory: { artifact: RegisteredArtifact; pages: IndexPage[] };
}

const HEX = /^[0-9a-f]{64}$/;
const bad = (detail: string): never => { throw new ReadError('corrupt', `Index manifest: ${detail}`); };
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 1024 && !/[\uD800-\uDFFF]/u.test(v);
const overlaps = (page: { first_key: string; last_key: string }, key: string) =>
  compareUtf8(page.first_key, key) <= 0 && compareUtf8(key, page.last_key) <= 0;

/** Checks one page list: contiguous from 0, within the cap, key-ordered, covering `total` bytes. */
function checkPages(pages: unknown, cap: number, total: number, what: string): IndexPage[] {
  if (!Array.isArray(pages) || pages.length < 1) return bad(`no ${what} pages`);
  let offset = 0;
  let previousLast: string | null = null;
  for (const page of pages as IndexPage[]) {
    if (!page || !isKey(page.first_key) || !isKey(page.last_key) || !isSafeCount(page.byte_offset) || !isSafeCount(page.byte_length)
        || page.byte_length < 1 || typeof page.sha256 !== 'string' || !HEX.test(page.sha256)) return bad(`invalid ${what} page`);
    if (page.byte_offset !== offset) return bad(`${what} pages are not contiguous`);
    if (page.byte_length > cap) return bad(`${what} page exceeds the declared cap`);
    if (compareUtf8(page.first_key, page.last_key) > 0) return bad(`${what} page keys out of order`);
    if (previousLast !== null && compareUtf8(previousLast, page.first_key) > 0) return bad(`${what} pages out of key order`);
    previousLast = page.last_key;
    offset += page.byte_length;
  }
  if (offset !== total) return bad(`${what} pages do not cover the file`);
  return pages as IndexPage[];
}

/** Checks a decoded manifest against its D1 registration before any page is used. Every artifact
 *  it names must be a registered artifact of this output with matching length and digest. */
export function checkManifest(raw: string, expect: { output: string; source: string; capability: string; state: string; pageCap: number },
                              artifacts: ReadonlyMap<string, RegisteredArtifact>): IndexManifest {
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw); } catch { return bad('not JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  if (m.format_version !== MANIFEST_VERSION) throw new ReadError('incompatible_index', `Unsupported index format ${String(m.format_version)}; the index must be rebuilt`);
  if (m.index_kind !== 'source_text' && m.index_kind !== 'word_language') return bad('unknown index kind');
  if (m.prepared_output_id !== expect.output) return bad('output identity mismatch');
  const sources = m.source_revision_ids;
  if (!Array.isArray(sources) || !sources.includes(expect.source)) return bad('source revision mismatch');
  if (JSON.stringify(m.ordering) !== '["search_key","native_order","occurrence_id"]' || m.key_collation !== 'utf8-bytewise') return bad('unsupported ordering');
  const cap = m.encoded_page_cap_bytes;
  if (!isSafeCount(cap) || cap < 1) return bad('page cap missing');
  if (cap > expect.pageCap) throw new ReadError('exceeds_limits', 'Index page cap exceeds the configured read cap');
  if (new TextEncoder().encode(raw).length > cap) return bad('manifest exceeds its page cap');
  const coverage = m.coverage as Record<string, unknown> | undefined;
  const capabilities = coverage?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes(expect.capability)) return bad('capability not declared');
  if (coverage?.state !== expect.state) return bad('coverage disagrees with the D1 record');
  const extent = m.native_extent as Record<string, unknown> | undefined;
  const units = extent?.unit_ids;
  const range = extent?.order_range;
  if (!Array.isArray(units) || !units.every(u => isIdentifier(u))) return bad('native extent missing');
  if (!Array.isArray(range) || range.length !== 2 || !range.every(isSafeCount) || range[0] > range[1]) return bad('order range missing');
  if (!isIdentifier(m.coordinate_version) || !isIdentifier(m.normalization_rule) || !isIdentifier(m.tokenizer_version)) return bad('processing basis missing');
  const registered = (id: unknown, format: string, length: unknown, sha: unknown): RegisteredArtifact => {
    const artifact = artifacts.get(String(id));
    if (!artifact) throw new ReadError('corrupt', 'Index manifest: file not registered for this output');
    if (artifact.format !== format || artifact.byte_count !== length || artifact.sha256 !== sha) return bad('file disagrees with its registration');
    return artifact;
  };
  if (!Array.isArray(m.files) || m.files.length < 1) return bad('no postings files');
  const postings = new Map<string, RegisteredArtifact>();
  for (const file of m.files as Record<string, unknown>[])
    postings.set(String(file?.artifact_id), registered(file?.artifact_id, POSTINGS_FORMAT, file?.byte_length, file?.sha256));
  const root = m.directory as Record<string, unknown> | undefined;
  if (!root || postings.has(String(root.artifact_id))) return bad('directory missing');
  const directoryArtifact = registered(root.artifact_id, DIRECTORY_FORMAT, root.byte_length, root.sha256);
  return {
    index_kind: m.index_kind, prepared_output_id: expect.output, source_revision_ids: sources as string[], unit_ids: units as string[],
    order_range: [range[0], range[1]], coordinate_version: m.coordinate_version, normalization_rule: m.normalization_rule,
    tokenizer_version: m.tokenizer_version, capabilities: capabilities as string[], coverage_state: String(coverage.state),
    coverage_limitation: typeof coverage.limitation === 'string' ? coverage.limitation : null, page_cap: cap, postings,
    directory: { artifact: directoryArtifact, pages: checkPages(root.pages, cap, directoryArtifact.byte_count, 'directory') },
  };
}

/** Directory pages whose key range contains `key`, as indices into the manifest root. */
export function candidateDirectoryPages(manifest: IndexManifest, key: string): number[] {
  return manifest.directory.pages.flatMap((page, i) => overlaps(page, key) ? [i] : []);
}

/** Parses and checks one verified directory page against its root entry and the manifest. */
export function directoryEntries(manifest: IndexManifest, root: IndexPage, text: string): DirectoryEntry[] {
  if (!text.endsWith('\n')) return bad('directory page is not line-aligned');
  const entries: DirectoryEntry[] = [];
  for (const line of text.slice(0, -1).split('\n')) {
    let entry: DirectoryEntry;
    try { entry = JSON.parse(line); } catch { return bad('unreadable directory entry'); }
    const file = manifest.postings.get(String(entry?.postings_artifact_id));
    if (!file || !isKey(entry.first_key) || !isKey(entry.last_key) || !isSafeCount(entry.byte_offset) || !isSafeCount(entry.byte_length)
        || entry.byte_length < 1 || entry.byte_length > manifest.page_cap || entry.byte_offset + entry.byte_length > file.byte_count
        || typeof entry.sha256 !== 'string' || !HEX.test(entry.sha256) || compareUtf8(entry.first_key, entry.last_key) > 0)
      return bad('invalid directory entry');
    const previous = entries.at(-1);
    if (previous && compareUtf8(previous.last_key, entry.first_key) > 0) return bad('directory entries out of key order');
    entries.push(entry);
  }
  if (!entries.length || entries[0].first_key !== root.first_key || entries.at(-1)!.last_key !== root.last_key)
    return bad('directory page boundaries disagree with the manifest');
  return entries;
}

export function entryOverlaps(entry: IndexPage, key: string) { return overlaps(entry, key); }
