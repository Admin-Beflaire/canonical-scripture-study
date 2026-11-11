/** Deterministic synthetic fixture for the Study search fit measurement (Data Indexes 0.6 format).
 *  Every word, identifier and attribution is invented. The fixture is staged as an UNSELECTED
 *  release (`fit-release`); the current release stays selected and is never touched. */

export const FIT_RELEASE = 'fit-release';
export const FIT_SOURCE = 'fit:synthetic:source_revision';
export const FIT_OUTPUT = 'fit-source-search';
export const FIT_KEY = 'fitcommon';
const COORD = 'fit:unicode-scalars/1';
const DIRECTORY_FORMAT = 'application/x-ndjson; profile=index-directory';

export interface FitObject { id: string; key: string; format: string; bytes: Uint8Array; sha256: string }
export interface FitFixture { pageCap: number; occurrences: string[]; objects: FitObject[]; rows: Record<string, Record<string, unknown>[]>; insertSql: string[]; deleteSql: string[] }

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes));
const byteOrder = (a: string, b: string) => {
  const x = enc.encode(a), y = enc.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])])) : value;
const canonical = (value: unknown) => JSON.stringify(sorted(value));

interface Page { first_key: string; last_key: string; byte_offset: number; byte_length: number; sha256: string }
async function pack(lines: { first: string; last: string; bytes: Uint8Array }[], cap: number) {
  const pages: Page[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0, current: typeof lines = [], size = 0;
  const flush = async () => {
    if (!current.length) return;
    const bytes = concat(current.map(l => l.bytes));
    pages.push({ first_key: current[0].first, last_key: current.at(-1)!.last, byte_offset: offset, byte_length: bytes.length, sha256: await sha256(bytes) });
    chunks.push(bytes); offset += bytes.length; current = []; size = 0;
  };
  for (const line of lines) {
    if (line.bytes.length > cap) throw new Error('Synthetic line exceeds the page cap');
    if (size + line.bytes.length > cap) await flush();
    current.push(line); size += line.bytes.length;
  }
  await flush();
  return { body: concat(chunks), pages };
}

const quote = (v: unknown) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const columns = (row: Record<string, unknown>) =>
  Object.entries(row).map(([k, v]) => [k, k.endsWith('_json') ? JSON.stringify(v) : v] as const);

/** `units` native units of `tokens` invented words each; FIT_KEY occurs once per unit, so it spans
 *  several pages at the cap. `native_order` is linear: unit * 1000 + token position. */
export async function buildFitFixture({ pageCap = 16384, units = 120, tokens = 6 } = {}): Promise<FitFixture> {
  const unitIds = Array.from({ length: units }, (_, u) => `fit-u${String(u).padStart(4, '0')}`);
  const postings: Record<string, unknown>[] = [];
  for (let u = 0; u < units; u++) for (let t = 0; t < tokens; t++) {
    const key = t === 2 ? FIT_KEY : `w${String((u * 31 + t * 17) % 400).padStart(3, '0')}`;
    const start = t * 8;
    postings.push({ posting_kind: 'source', search_key: key, source_revision_id: FIT_SOURCE, span_id: `fit-span-${unitIds[u]}`,
      coordinate_version: COORD, native_order: u * 1000 + start, occurrence_id: `${unitIds[u]}:${start}:${start + 7}`,
      native_reference: { schema_version: 'native-reference/1', source_revision_id: FIT_SOURCE, coordinate_version: COORD,
        segments: [{ unit_id: unitIds[u], start, end: start + 7 }] } });
  }
  postings.sort((a, b) => byteOrder(a.search_key as string, b.search_key as string)
    || (a.native_order as number) - (b.native_order as number) || byteOrder(a.occurrence_id as string, b.occurrence_id as string));
  const orderRange = [0, (units - 1) * 1000 + 999];
  const post = await pack(postings.map(p => ({ first: p.search_key as string, last: p.search_key as string, bytes: enc.encode(canonical(p) + '\n') })), pageCap);
  const postSha = await sha256(post.body);
  const postingsId = `${FIT_OUTPUT}:postings:${postSha.slice(0, 20)}`;
  const entries = post.pages.map(page => ({ postings_artifact_id: postingsId, ...page }));
  const dir = await pack(entries.map(e => ({ first: e.first_key, last: e.last_key, bytes: enc.encode(canonical(e) + '\n') })), pageCap);
  const dirSha = await sha256(dir.body);
  const directoryId = `${FIT_OUTPUT}:directory:${dirSha.slice(0, 20)}`;
  const parameters = { encoded_page_cap_bytes: pageCap, normalization_rule: 'fit:identity/1', tokenizer_version: 'fit:fixed/1' };
  const manifest = enc.encode(canonical({
    format_version: 'index-manifest/2', index_kind: 'source_text', prepared_output_id: FIT_OUTPUT, source_revision_ids: [FIT_SOURCE],
    native_extent: { unit_ids: unitIds, order_range: orderRange }, coordinate_version: COORD,
    normalization_rule: parameters.normalization_rule, tokenizer_version: parameters.tokenizer_version, analysis_revision_ids: [], parameters,
    ordering: ['search_key', 'native_order', 'occurrence_id'], key_collation: 'utf8-bytewise', encoded_page_cap_bytes: pageCap,
    files: [{ artifact_id: postingsId, byte_length: post.body.length, sha256: postSha }],
    directory: { artifact_id: directoryId, byte_length: dir.body.length, sha256: dirSha, pages: dir.pages },
    coverage: { capabilities: ['word_exact'], state: 'available', limitation: null },
  }));
  if (manifest.length > pageCap) throw new Error('Synthetic manifest exceeds the page cap');
  const manifestSha = await sha256(manifest);
  const manifestId = `${FIT_OUTPUT}:manifest:${manifestSha.slice(0, 20)}`;
  const objects: FitObject[] = [
    { id: postingsId, key: `synthetic/fit/${postSha}/postings.ndjson`, format: 'application/x-ndjson', bytes: post.body, sha256: postSha },
    { id: directoryId, key: `synthetic/fit/${dirSha}/directory.ndjson`, format: DIRECTORY_FORMAT, bytes: dir.body, sha256: dirSha },
    { id: manifestId, key: `synthetic/fit/${manifestSha}/manifest.json`, format: 'application/json', bytes: manifest, sha256: manifestSha },
  ];
  const nodes = ['work', 'edition', 'representation', 'source_revision'].map((kind, i, all) => ({
    id: `fit:synthetic:${kind}`, kind, parent_id: i ? `fit:synthetic:${all[i - 1]}` : null, name: 'Synthetic fit source',
    attribution: 'Synthetic fit source, invented', origin: 'https://example.invalid/fit', details_json: {} }));
  const rows: FitFixture['rows'] = {
    source_nodes: nodes,
    prepared_outputs: [{ id: FIT_OUTPUT, kind: 'source_search', input_revisions_json: [FIT_SOURCE], method_version: 'fit:method/1',
      parameters_json: parameters, native_extent_json: { coordinate_version: COORD, unit_ids: unitIds }, validation_basis_json: { fixture: 'study-fit/2' } }],
    artifacts: objects.map(o => ({ id: o.id, source_revision_id: FIT_SOURCE, output_id: FIT_OUTPUT, sha256: o.sha256,
      byte_count: o.bytes.length, format: o.format, registered_locator: o.key })),
    coverage: [{ output_id: FIT_OUTPUT, source_revision_id: FIT_SOURCE, native_extent_json: { unit_ids: unitIds, order_range: orderRange },
      capability: 'word_exact', state: 'available', method_version: 'fit:method/1', index_artifact_id: manifestId, dependencies_json: [], limitation: null }],
    releases: [{ id: FIT_RELEASE, manifest_revision: 'fit:manifest/1', recipe_revision: 'fit:recipe/1',
      schema_versions_json: { evidence_records: '1', native_reference: '1' }, coverage_basis: 'synthetic fit fixture',
      quality_receipt: 'synthetic:fit-quality', scope_receipt: 'synthetic:fit-scope' }],
    release_outputs: [{ release_id: FIT_RELEASE, output_id: FIT_OUTPUT }],
  };
  const insertSql = Object.entries(rows).flatMap(([table, list]) => list.map(row => {
    const cols = columns(row);
    return `INSERT INTO ${table} (${cols.map(([k]) => k).join(', ')}) VALUES (${cols.map(([, v]) => quote(v)).join(', ')});`;
  }));
  const deleteSql = [
    `DELETE FROM release_outputs WHERE release_id = '${FIT_RELEASE}' AND output_id = '${FIT_OUTPUT}';`,
    `DELETE FROM releases WHERE id = '${FIT_RELEASE}';`,
    `DELETE FROM coverage WHERE output_id = '${FIT_OUTPUT}';`,
    `DELETE FROM artifacts WHERE output_id = '${FIT_OUTPUT}';`,
    `DELETE FROM prepared_outputs WHERE id = '${FIT_OUTPUT}';`,
    ...[...nodes].reverse().map(n => `DELETE FROM source_nodes WHERE id = '${n.id}';`),
  ];
  const occurrences = postings.filter(p => p.search_key === FIT_KEY).map(p => p.occurrence_id as string);
  return { pageCap, occurrences, objects, rows, insertSql, deleteSql };
}
