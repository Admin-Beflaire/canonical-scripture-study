/** Synthetic selected data for Study read tests. No real source text: every word,
 *  identifier and attribution here is invented. Two releases share one source. */
import { createHash } from 'node:crypto';
import { localD1 } from '../maintenance/d1.ts';
import type { R2ReadBucket, StudyReadEnvironment } from '../../services/study/src/read/bindings.ts';

const enc = new TextEncoder();
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export const A = 'syn:a:source_revision';
export const B = 'syn:b:source_revision';
export const COORD = 'syn:unicode-scalars/1';

/** Native units (Unicode scalars). `u1` and `u2` are two partitions of source A. */
export const UNITS: Record<string, string> = {
  u1: 'alpha beta alpha gamma alpha delta alpha',
  u2: 'alpha epsilon alpha zeta',
  b1: 'alpha theta',
};
const BODY = 'Synthetic commentary body: alpha is discussed here.';

export interface Posting {
  posting_kind: 'source' | 'word'; search_key: string; source_revision_id: string; span_id: string;
  coordinate_version: string; native_order: number; occurrence_id: string;
  native_reference: { schema_version: 'native-reference/1'; source_revision_id: string; coordinate_version: string;
    segments: { unit_id: string; start: number; end: number }[] };
  lookup_kind?: string; form_id?: string; form?: string; analyses?: unknown[];
}

function tokens(unit: string) {
  const out: { word: string; start: number; end: number }[] = [];
  const text = Array.from(UNITS[unit]);
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const space = i === text.length || text[i] === ' ';
    if (!space && start < 0) start = i;
    if (space && start >= 0) { out.push({ word: text.slice(start, i).join(''), start, end: i }); start = -1; }
  }
  return out;
}

export function sourcePostings(source: string, units: string[], span: (unit: string) => string, extraKeys: [string, number][] = []) {
  const postings: Posting[] = [];
  let order = 0;
  for (const unit of units) for (const t of tokens(unit)) postings.push(posting(source, span(unit), unit, t, order++, t.word));
  // Extra synthetic keys (repeated occurrences) to make a key span several pages.
  for (const [key, count] of extraKeys) for (let i = 0; i < count; i++)
    postings.push(posting(source, span(units[0]), units[0], { start: 0, end: 5 }, 1000 + i, key, `occ-${key.length}-${String(i).padStart(3, '0')}`));
  return postings;
}

function posting(source: string, spanId: string, unit: string, t: { start: number; end: number }, order: number, key: string, occ?: string): Posting {
  return { posting_kind: 'source', search_key: key, source_revision_id: source, span_id: spanId, coordinate_version: COORD,
    native_order: order, occurrence_id: occ ?? `${unit}-occ-${String(order).padStart(4, '0')}`,
    native_reference: { schema_version: 'native-reference/1', source_revision_id: source, coordinate_version: COORD,
      segments: [{ unit_id: unit, start: t.start, end: t.end }] } };
}

export function wordPostings(source: string, base: Posting[]): Posting[] {
  const out: Posting[] = [];
  for (const p of base.filter(row => row.native_order < 1000)) {
    const analyses = [
      { analysis_id: `prov-a:${p.occurrence_id}`, analysis_revision_id: 'syn:prov-a:source_revision', lemma_id: `prov-a:lemma-${p.search_key}`,
        grammar: { part_of_speech: 'noun' }, provider: 'syn-provider-a', basis: 'syn-receipt-a' },
      { analysis_id: `prov-b:${p.occurrence_id}`, analysis_revision_id: 'syn:prov-b:source_revision', lemma_id: `prov-b:lemma-${p.search_key}`,
        grammar: { part_of_speech: 'verb' }, provider: 'syn-provider-b', basis: 'syn-receipt-b' },
    ];
    const keys: [string, string][] = [['form', `form:${p.search_key}`], ['lemma', `lemma:prov-a:lemma-${p.search_key}`],
      ['lemma', `lemma:prov-b:lemma-${p.search_key}`], ['grammar', 'grammar:noun'], ['grammar', 'grammar:verb']];
    for (const [lookup_kind, search_key] of keys)
      out.push({ ...p, posting_kind: 'word', search_key, lookup_kind, form_id: `form:${p.search_key}`, form: p.search_key, analyses });
  }
  return out;
}

export interface BuiltIndex { output: string; manifest: Uint8Array; postings: Uint8Array; manifestId: string; postingsId: string; capabilities: string[] }

/** Builds an index in the Data Indexes v1 format: sorted NDJSON split into line-aligned pages. */
export function buildIndex(output: string, kind: 'source_text' | 'word_language', source: string, units: string[], rows: Posting[], pageCap: number): BuiltIndex {
  const sorted = [...rows].sort((x, y) => byteOrder(x.search_key, y.search_key) || x.native_order - y.native_order || byteOrder(x.occurrence_id, y.occurrence_id));
  const lines = sorted.map(row => ({ key: row.search_key, bytes: enc.encode(JSON.stringify(row) + '\n') }));
  const pages: { first_key: string; last_key: string; byte_offset: number; byte_length: number; sha256: string }[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let current: typeof lines = [];
  const flush = () => {
    if (!current.length) return;
    const bytes = Buffer.concat(current.map(l => l.bytes));
    pages.push({ first_key: current[0].key, last_key: current[current.length - 1].key, byte_offset: offset, byte_length: bytes.length, sha256: sha(bytes) });
    chunks.push(bytes); offset += bytes.length; current = [];
  };
  for (const line of lines) {
    if (line.bytes.length > pageCap) throw new Error('Synthetic posting exceeds page cap');
    if (current.reduce((n, l) => n + l.bytes.length, 0) + line.bytes.length > pageCap) flush();
    current.push(line);
  }
  flush();
  const postings = Buffer.concat(chunks);
  const postingsId = `${output}:postings`;
  const capabilities = kind === 'source_text' ? ['word_exact'] : ['form_exact', 'grammar_exact', 'lemma_exact'];
  const manifest = enc.encode(JSON.stringify({
    format_version: 'index-manifest/1', index_kind: kind, prepared_output_id: output, source_revision_ids: [source],
    native_extent: { unit_ids: units }, coordinate_version: COORD, normalization_rule: 'syn:identity/1', tokenizer_version: 'syn:spaces/1',
    analysis_revision_ids: kind === 'word_language' ? ['syn:prov-a:source_revision', 'syn:prov-b:source_revision'] : [],
    parameters: { encoded_page_cap_bytes: pageCap }, ordering: ['search_key', 'native_order', 'occurrence_id'], key_collation: 'utf8-bytewise',
    encoded_page_cap_bytes: pageCap, files: [{ artifact_id: postingsId, byte_length: postings.length, sha256: sha(postings), pages }],
    coverage: { capabilities, state: 'available', limitation: null },
  }));
  return { output, manifest, postings, manifestId: `${output}:manifest`, postingsId, capabilities };
}

/** In-memory R2 with range reads, call log and fault injection. */
export class MemoryBucket implements R2ReadBucket {
  objects = new Map<string, Uint8Array>();
  reads: { key: string; offset?: number; length?: number }[] = [];
  corrupt = new Set<string>();
  failing = new Set<string>();
  async get(key: string, options?: { range: { offset: number; length: number } }) {
    this.reads.push({ key, offset: options?.range.offset, length: options?.range.length });
    if (this.failing.has(key)) throw new Error('synthetic provider failure');
    const data = this.objects.get(key);
    if (!data) return null;
    const { offset, length } = options?.range ?? { offset: 0, length: data.length };
    const bytes = Uint8Array.from(data.subarray(offset, offset + length));
    if (this.corrupt.has(key) && bytes.length) bytes[0] ^= 1;
    return { arrayBuffer: async () => bytes.buffer };
  }
}

export interface Fixture {
  env: StudyReadEnvironment; db: ReturnType<typeof localD1>; bucket: MemoryBucket;
  indexes: Record<string, BuiltIndex>; postings: Record<string, Posting[]>; select(current: string | null, previous?: string | null): void;
}

const jsonColumns = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k.endsWith('_json') ? JSON.stringify(v) : v]));

/** Builds two releases. `rel-2` is current unless `select` changes it.
 *  `pageCap` controls how many pages a common key spans. */
export function buildFixture({ pageCap = 2048, commonCount = 24 } = {}): Fixture {
  const db = localD1();
  const bucket = new MemoryBucket();
  const insert = (table: string, row: Record<string, unknown>) => {
    const r = jsonColumns(row);
    const cols = Object.keys(r);
    db.sqlite.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(Object.values(r) as (string | number | null)[]));
  };
  for (const [prefix, name] of [['syn:a', 'Synthetic source A'], ['syn:b', 'Synthetic source B'], ['syn:prov-a', 'Synthetic analysis A'], ['syn:prov-b', 'Synthetic analysis B']]) {
    let parent: string | null = null;
    for (const kind of ['work', 'edition', 'representation', 'source_revision']) {
      insert('source_nodes', { id: `${prefix}:${kind}`, kind, parent_id: parent, name, attribution: `${name}, synthetic attribution`, origin: 'https://example.invalid/', details_json: {} });
      parent = `${prefix}:${kind}`;
    }
  }
  const output = (id: string, kind: string) => insert('prepared_outputs', { id, kind, input_revisions_json: [A], method_version: 'syn:method/1',
    parameters_json: {}, native_extent_json: {}, validation_basis_json: { fixture: 'study-read/1' } });
  for (const [id, kind] of [['syn-ev', 'evidence'], ['syn-ev-old', 'evidence'], ['syn-src-1', 'source_search'], ['syn-src-2', 'source_search'],
    ['syn-src-b', 'source_search'], ['syn-src-old', 'source_search'], ['syn-word-1', 'word_index'], ['syn-pkg', 'package'],
    ['syn-statement', 'character_statement'], ['syn-ev-b', 'evidence']]) output(id, kind);

  const payload = (text: string) => { const id = sha(text); db.sqlite.prepare('INSERT OR IGNORE INTO text_payloads VALUES (?, ?)').run(id, text); return id; };
  const span = (row: Record<string, unknown>) => insert('native_spans', { parent_id: null, coordinate_version: COORD, basis_json: { receipt: 'syn' },
    body_ranges_json: [], content_id: null, reading_kind: 'preserved', ...row });
  span({ id: 'a-u1', output_id: 'syn-ev', source_revision_id: A, kind: 'verse', label: 'A 1', native_order: 0, segments_json: [{ unit_id: 'u1', start: 0, end: Array.from(UNITS.u1).length }], content_id: payload(UNITS.u1) });
  span({ id: 'a-u2', output_id: 'syn-ev', source_revision_id: A, kind: 'verse', label: 'A 2', native_order: 1, segments_json: [{ unit_id: 'u2', start: 0, end: Array.from(UNITS.u2).length }], content_id: payload(UNITS.u2) });
  span({ id: 'a-unit', output_id: 'syn-ev', source_revision_id: A, kind: 'literary_unit', label: 'A unit', native_order: 2,
    segments_json: [{ unit_id: 'u1', start: 0, end: 5 }, { unit_id: 'u2', start: 0, end: 5 }], content_id: payload('alphaalpha'), basis_json: { receipt: 'syn', disputed: true } });
  const body = enc.encode(BODY);
  const bodyId = 'syn-body';
  const [s0, s1] = [[0, 10], [28, 33]];
  span({ id: 'a-comment', output_id: 'syn-ev', source_revision_id: A, kind: 'commentary', label: 'A comment', native_order: 3,
    segments_json: [{ unit_id: 'c1', start: 0, end: 10 }, { unit_id: 'c1', start: 28, end: 33 }], reading_kind: 'extracted',
    body_ranges_json: [s0, s1].map(([start, end], i) => ({ segment_ordinal: i, artifact_id: bodyId, byte_offset: start, byte_length: end - start, sha256: sha(body.subarray(start, end)) })) });
  span({ id: 'a-gap', output_id: 'syn-ev', source_revision_id: A, kind: 'verse', label: 'A gap', native_order: 4, segments_json: [{ unit_id: 'u9', start: 0, end: 0 }], reading_kind: 'gap' });
  span({ id: 'a-old', output_id: 'syn-ev-old', source_revision_id: A, kind: 'verse', label: 'A 1 (old wording)', native_order: 0, segments_json: [{ unit_id: 'u1', start: 0, end: 5 }], content_id: payload('OLD wording') });
  span({ id: 'b-1', output_id: 'syn-ev-b', source_revision_id: B, kind: 'verse', label: 'B 1', native_order: 0, segments_json: [{ unit_id: 'b1', start: 0, end: 11 }], content_id: payload(UNITS.b1) });
  insert('artifacts', { id: bodyId, source_revision_id: A, output_id: 'syn-ev', sha256: sha(body), byte_count: body.length, format: 'text/utf-8', registered_locator: 'synthetic/body/syn-body' });
  bucket.objects.set('synthetic/body/syn-body', body);
  for (const [spanId, kind, start, end] of [['a-u1', 'verse', 0, 6], ['a-u2', 'verse', 7, 10], ['a-unit', 'literary_unit', 0, 0], ['a-unit', 'literary_unit', 7, 7]] as const)
    insert('span_segments', { span_id: spanId, segment_ordinal: spanId === 'a-unit' && start === 7 ? 1 : 0, source_revision_id: A, kind, start_order: start, end_order: end });
  insert('annotations', { id: 'ann-1', output_id: 'syn-ev', source_revision_id: A, span_id: 'a-u1', kind: 'witness_reading', provider: 'syn-provider-a', basis_json: { receipt: 'syn' }, details_json: { note: 'synthetic' } });
  insert('relationships', { id: 'rel-x', output_id: 'syn-ev', kind: 'parallel', direction: 'directed', status: 'disputed', basis_json: { receipt: 'syn' } });
  insert('relation_members', { relationship_id: 'rel-x', role: 'from', ordinal: 0, span_id: 'a-u1', correspondence: 'partial', gap_reason: null });
  insert('relation_members', { relationship_id: 'rel-x', role: 'to', ordinal: 0, span_id: 'a-old', correspondence: 'partial', gap_reason: null });
  insert('relation_members', { relationship_id: 'rel-x', role: 'to', ordinal: 1, span_id: null, correspondence: 'missing', gap_reason: 'not preserved' });
  insert('study_packages', { id: 'pkg-1', output_id: 'syn-pkg', subject: 'synthetic-subject', source_refs_json: [{ span_id: 'a-u1' }], dependency_ids_json: ['syn-ev'] });
  insert('character_statements', { id: 'stmt-1', output_id: 'syn-statement', name: 'Synthetic statement', version: '1', status: 'approved',
    scripture_basis_json: [{ span_id: 'a-u1' }], owner_approval_ref: 'private:approval-ref' });

  const indexes: Record<string, BuiltIndex> = {};
  const postings: Record<string, Posting[]> = {};
  const addIndex = (built: BuiltIndex, source: string, units: string[], rows: Posting[], state = 'available', limitation: string | null = null) => {
    indexes[built.output] = built; postings[built.output] = rows;
    for (const [id, bytes, format] of [[built.manifestId, built.manifest, 'application/json'], [built.postingsId, built.postings, 'application/x-ndjson']] as const) {
      insert('artifacts', { id, source_revision_id: source, output_id: built.output, sha256: sha(bytes), byte_count: bytes.length, format, registered_locator: `synthetic/indexes/${id.replace(':', '/')}` });
      bucket.objects.set(`synthetic/indexes/${id.replace(':', '/')}`, bytes);
    }
    for (const capability of built.capabilities)
      insert('coverage', { output_id: built.output, source_revision_id: source, native_extent_json: { unit_ids: units }, capability, state,
        method_version: 'syn:method/1', index_artifact_id: built.manifestId, dependencies_json: ['syn-ev'], limitation });
  };
  const astral = '\u{10900}';   // above U+FFFF: UTF-16 and UTF-8 orders disagree with U+FB00
  const p1 = sourcePostings(A, ['u1'], () => 'a-u1', [['common', commonCount], [astral, 2], ['ﬀ', 2]]);
  addIndex(buildIndex('syn-src-1', 'source_text', A, ['u1'], p1, pageCap), A, ['u1'], p1);
  const p2 = sourcePostings(A, ['u2'], () => 'a-u2');
  for (const p of p2) p.native_order += 100;
  addIndex(buildIndex('syn-src-2', 'source_text', A, ['u2'], p2, pageCap), A, ['u2'], p2);
  const pb = sourcePostings(B, ['b1'], () => 'b-1');
  addIndex(buildIndex('syn-src-b', 'source_text', B, ['b1'], pb, pageCap), B, ['b1'], pb, 'partial', 'synthetic partial extent');
  const pOld = sourcePostings(A, ['u1'], () => 'a-old', [['onlyold', 1]]);
  addIndex(buildIndex('syn-src-old', 'source_text', A, ['u1'], pOld, pageCap), A, ['u1'], pOld);
  const pw = wordPostings(A, [...p1, ...p2]);
  addIndex(buildIndex('syn-word-1', 'word_language', A, ['u1', 'u2'], pw, pageCap), A, ['u1', 'u2'], pw);

  for (const [id, members] of [['rel-1', ['syn-ev-old', 'syn-src-old']], ['rel-2', ['syn-ev', 'syn-ev-b', 'syn-src-1', 'syn-src-2', 'syn-src-b', 'syn-word-1', 'syn-pkg', 'syn-statement']]] as const) {
    insert('releases', { id, manifest_revision: 'syn:manifest/1', recipe_revision: 'syn:recipe/1', schema_versions_json: { evidence_records: '1', native_reference: '1' },
      coverage_basis: 'synthetic', quality_receipt: `syn:quality/${id}`, scope_receipt: `syn:scope/${id}` });
    for (const output_id of members) insert('release_outputs', { release_id: id, output_id });
  }
  const select = (current: string | null, previous: string | null = null) =>
    db.sqlite.prepare('UPDATE release_selection SET current_release_id = ?, previous_release_id = ? WHERE singleton_id = 1').run(current, previous);
  select('rel-2', 'rel-1');
  const env: StudyReadEnvironment = { DATA_DB: db, PRIVATE_OBJECTS: bucket, MAX_PAGE_BYTES: 65536, REQUEST_BYTES: 262144, MAX_D1_CALLS: 25, MAX_SUBREQUESTS: 40 };
  return { env, db, bucket, indexes, postings, select };
}
