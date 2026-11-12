/** Synthetic passage data in the shape Preparation records: verse spans `output#unit` with their
 *  wording in an R2 body artifact, source-context coverage listing the units, span segments in
 *  the source's linear order, and textual notes. No real source text: every word is invented. */
import { createHash } from 'node:crypto';
import { localD1 } from '../maintenance/d1.ts';
import { MemoryBucket } from './fixture.ts';
import type { StudyReadEnvironment } from '../../services/study/src/read/bindings.ts';

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const enc = new TextEncoder();

export const HEB = 'syn:heb:source_revision';
export const GRK = 'syn:grk:source_revision';

/** Synthetic wording for a unit; the verse number is part of it so tests can check order. */
export const wording = (unit: string) => `synthetic ${unit.toLowerCase()} words`;

export interface PassageFixture { env: StudyReadEnvironment; db: ReturnType<typeof localD1>; bucket: MemoryBucket; bodies: Record<string, string> }

/** Two sources. HEB: book Gen, chapter 1 with 40 verses and chapter 2 with 5, split over two
 *  evidence outputs (chapter 1 / chapter 2) as Preparation splits a book into units. GRK: Mat 1:1-3. */
export function buildPassageFixture(): PassageFixture {
  const db = localD1();
  const bucket = new MemoryBucket();
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    const values = Object.entries(row).map(([k, v]) => k.endsWith('_json') ? JSON.stringify(v) : v);
    db.sqlite.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(values as (string | number | null)[]));
  };
  for (const [prefix, name] of [['syn:heb', 'Synthetic Hebrew-like text'], ['syn:grk', 'Synthetic Greek-like text']]) {
    let parent: string | null = null;
    for (const kind of ['work', 'edition', 'representation', 'source_revision']) {
      insert('source_nodes', { id: `${prefix}:${kind}`, kind, parent_id: parent, name: `${name} ${kind}`, attribution: `${name}, synthetic attribution`, origin: 'https://example.invalid/', details_json: {} });
      parent = `${prefix}:${kind}`;
    }
  }
  const bodies: Record<string, string> = {};
  let order = 0;
  const outputs: string[] = [];
  const evidence = (output: string, source: string, units: string[], coordinate: string) => {
    insert('prepared_outputs', { id: output, kind: 'evidence', input_revisions_json: [source], method_version: 'syn:method/1', parameters_json: {},
      native_extent_json: { coordinate_version: coordinate, unit_ids: units }, validation_basis_json: { fixture: 'study-passage/1' } });
    const artifact = `${output}:body`;
    let body = '';
    const spans: Record<string, unknown>[] = [];
    units.forEach((unit, i) => {
      const text = wording(unit);
      const bytes = enc.encode(text);
      const offset = enc.encode(body).length;
      body += text;
      const scalars = Array.from(text).length;
      spans.push({ id: `${output}#${unit}`, output_id: output, source_revision_id: source, parent_id: null, kind: 'verse', label: unit.replace(/\./, ' ').replace(/\.(\d+)$/, ':$1'),
        native_order: i, coordinate_version: coordinate, segments_json: [{ unit_id: unit, start: 0, end: scalars }], basis_json: { rows: 'synthetic rows' },
        content_id: null, reading_kind: 'extracted',
        body_ranges_json: [{ segment_ordinal: 0, artifact_id: artifact, byte_offset: offset, byte_length: bytes.length, sha256: sha(bytes) }], start: order });
      order += scalars + 1;
    });
    const bytes = enc.encode(body);
    insert('artifacts', { id: artifact, source_revision_id: source, output_id: output, sha256: sha(bytes), byte_count: bytes.length, format: 'text/utf-8', registered_locator: `synthetic/body/${output}` });
    bucket.objects.set(`synthetic/body/${output}`, bytes);
    bodies[output] = body;
    for (const span of spans) {
      const { start, ...row } = span;
      insert('native_spans', row);
      const segments = row.segments_json as { start: number; end: number }[];
      insert('span_segments', { span_id: row.id, segment_ordinal: 0, source_revision_id: source, kind: 'verse', start_order: start, end_order: (start as number) + segments[0].end - 1 });
    }
    insert('coverage', { output_id: output, source_revision_id: source, native_extent_json: { coordinate_version: coordinate, unit_ids: units }, capability: 'source_context',
      state: 'available', method_version: 'syn:method/1', index_artifact_id: null, dependencies_json: [], limitation: null });
    outputs.push(output);
  };
  const ch1 = Array.from({ length: 40 }, (_, i) => `Gen.1.${i + 1}`);
  const ch2 = Array.from({ length: 5 }, (_, i) => `Gen.2.${i + 1}`);
  evidence('evidence:heb1', HEB, ch1, 'syn:heb-verses/1');
  evidence('evidence:heb2', HEB, ch2, 'syn:heb-verses/1');
  order = 0;
  evidence('evidence:grk1', GRK, ['Mat.1.1', 'Mat.1.2', 'Mat.1.3'], 'syn:grk-verses/1');
  insert('annotations', { id: 'note-1', output_id: 'evidence:heb1', source_revision_id: HEB, span_id: 'evidence:heb1#Gen.1.2', kind: 'textual_variants',
    provider: 'syn-provider', basis_json: { columns: 'synthetic' }, details_json: { words: [{ row: 1, spelling_variants: 'synthetic variant' }] } });
  insert('releases', { id: 'rel-p', manifest_revision: 'syn:manifest/1', recipe_revision: 'syn:recipe/1',
    schema_versions_json: { evidence_records: '1', native_reference: '1', index_manifest: '2' }, coverage_basis: 'synthetic', quality_receipt: 'syn:q', scope_receipt: 'syn:s' });
  for (const output_id of outputs) insert('release_outputs', { release_id: 'rel-p', output_id });
  db.sqlite.prepare('UPDATE release_selection SET current_release_id = ? WHERE singleton_id = 1').run('rel-p');
  const env: StudyReadEnvironment = { DATA_DB: db, PRIVATE_OBJECTS: bucket, MAX_PAGE_BYTES: 65536, REQUEST_BYTES: 262144, MAX_D1_CALLS: 25, MAX_SUBREQUESTS: 40 };
  return { env, db, bucket, bodies };
}
