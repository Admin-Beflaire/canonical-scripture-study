import { compareUtf8, isIdentifier, isSafeCount } from './bytes.ts';
import type { RegisteredArtifact } from './objects.ts';
import { ReadError } from './states.ts';

/** The parts of an `index-manifest/1` document the reader relies on. */
export interface IndexPage { first_key: string; last_key: string; byte_offset: number; byte_length: number; sha256: string }
export interface IndexFile { artifact: RegisteredArtifact; pages: IndexPage[] }
export interface IndexManifest {
  index_kind: 'source_text' | 'word_language'; prepared_output_id: string; source_revision_ids: string[];
  unit_ids: string[]; coordinate_version: string; normalization_rule: string; tokenizer_version: string;
  capabilities: string[]; coverage_state: string; coverage_limitation: string | null; files: IndexFile[];
}

const HEX = /^[0-9a-f]{64}$/;
const bad = (detail: string): never => { throw new ReadError('corrupt', `Index manifest: ${detail}`); };
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 1024 && !/[\uD800-\uDFFF]/u.test(v);

/** Checks a decoded manifest against its D1 registration before any page is used:
 *  identity, ordering, page cap, contiguous line-aligned pages and registered postings files. */
export function checkManifest(raw: string, expect: { output: string; source: string; capability: string; state: string; pageCap: number },
                              artifacts: ReadonlyMap<string, RegisteredArtifact>): IndexManifest {
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw); } catch { return bad('not JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('not an object');
  if (m.format_version !== 'index-manifest/1') return bad('unsupported format');
  if (m.index_kind !== 'source_text' && m.index_kind !== 'word_language') return bad('unknown index kind');
  if (m.prepared_output_id !== expect.output) return bad('output identity mismatch');
  const sources = m.source_revision_ids;
  if (!Array.isArray(sources) || !sources.includes(expect.source)) return bad('source revision mismatch');
  if (JSON.stringify(m.ordering) !== '["search_key","native_order","occurrence_id"]' || m.key_collation !== 'utf8-bytewise') return bad('unsupported ordering');
  if (!isSafeCount(m.encoded_page_cap_bytes) || m.encoded_page_cap_bytes < 1) return bad('page cap missing');
  if (m.encoded_page_cap_bytes > expect.pageCap) throw new ReadError('exceeds_limits', 'Index page cap exceeds the configured read cap');
  const coverage = m.coverage as Record<string, unknown> | undefined;
  const capabilities = coverage?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes(expect.capability)) return bad('capability not declared');
  if (coverage?.state !== expect.state) return bad('coverage disagrees with the D1 record');
  const extent = (m.native_extent as Record<string, unknown> | undefined)?.unit_ids;
  if (!Array.isArray(extent) || !extent.every(u => isIdentifier(u))) return bad('native extent missing');
  if (!isIdentifier(m.coordinate_version) || !isIdentifier(m.normalization_rule) || !isIdentifier(m.tokenizer_version)) return bad('processing basis missing');
  if (!Array.isArray(m.files) || m.files.length < 1) return bad('no files');
  const files: IndexFile[] = m.files.map((file: Record<string, unknown>) => {
    const artifact = artifacts.get(String(file?.artifact_id));
    if (!artifact) throw new ReadError('corrupt', 'Index manifest: postings file not registered for this output');
    if (artifact.format !== 'application/x-ndjson' || artifact.byte_count !== file.byte_length || artifact.sha256 !== file.sha256)
      return bad('postings file disagrees with its registration');
    const pages = file.pages;
    if (!Array.isArray(pages) || pages.length < 1) return bad('no pages');
    let offset = 0;
    let previousLast: string | null = null;
    for (const page of pages as IndexPage[]) {
      if (!page || !isKey(page.first_key) || !isKey(page.last_key) || !isSafeCount(page.byte_offset) || !isSafeCount(page.byte_length)
          || page.byte_length < 1 || typeof page.sha256 !== 'string' || !HEX.test(page.sha256)) return bad('invalid page entry');
      if (page.byte_offset !== offset) return bad('pages are not contiguous');
      if (page.byte_length > (m.encoded_page_cap_bytes as number)) return bad('page exceeds the declared cap');
      if (compareUtf8(page.first_key, page.last_key) > 0) return bad('page keys out of order');
      if (previousLast !== null && compareUtf8(previousLast, page.first_key) > 0) return bad('pages out of key order');
      previousLast = page.last_key;
      offset += page.byte_length;
    }
    if (offset !== artifact.byte_count) return bad('pages do not cover the file');
    return { artifact, pages: pages as IndexPage[] };
  });
  return {
    index_kind: m.index_kind, prepared_output_id: expect.output, source_revision_ids: sources as string[], unit_ids: extent as string[],
    coordinate_version: m.coordinate_version, normalization_rule: m.normalization_rule, tokenizer_version: m.tokenizer_version,
    capabilities: capabilities as string[], coverage_state: String(coverage.state),
    coverage_limitation: typeof coverage.limitation === 'string' ? coverage.limitation : null, files,
  };
}

/** Every page whose inclusive key range contains `key`, in manifest order. */
export function candidatePages(manifest: IndexManifest, key: string): { file: number; page: number }[] {
  const out: { file: number; page: number }[] = [];
  manifest.files.forEach((file, f) => file.pages.forEach((page, p) => {
    if (compareUtf8(page.first_key, key) <= 0 && compareUtf8(key, page.last_key) <= 0) out.push({ file: f, page: p });
  }));
  return out;
}
