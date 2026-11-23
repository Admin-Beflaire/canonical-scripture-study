/** Synthetic language-aid entries in the stored shape: one entries file per output in R2, one small
 *  D1 row per entry. Add entries while the output is not selected (`f.select(null, null)`). */
import {createHash} from 'node:crypto';
import {A, type Fixture} from './fixture.ts';

export const AID_FORMAT = 'application/x-ndjson; profile=aid-entries';
const LOOKUP = {
  lexicon_entry: 'strong_base',
  grammar_expansion: 'code',
  proper_name: 'disambiguated_strong',
} as const;
export interface AidSpec {
  kind: keyof typeof LOOKUP;
  details: Record<string, unknown>;
  text?: string | null;
  provider?: string;
  /** Changes the stored line (its row is computed from the result): for corruption tests. */
  edit?: (line: string) => string;
}
const held = new WeakMap<object, Map<string, AidSpec[]>>();
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const aidKey = (output: string) => `synthetic/aids/${output}.ndjson`;

/** Appends entries to an output's entries file and rewrites the file, its artifact and its rows. */
export function addAids(
  f: Fixture,
  output: string,
  specs: AidSpec[],
  source = A,
  format = AID_FORMAT,
): void {
  const rows = held.get(f.db) ?? new Map<string, AidSpec[]>();
  held.set(f.db, rows);
  const all = [...(rows.get(output) ?? []), ...specs];
  rows.set(output, all);
  const sql = f.db.sqlite;
  const artifact = `${output}:entries`;
  sql.prepare('DELETE FROM aid_entries WHERE output_id = ?').run(output);
  sql.prepare('DELETE FROM coverage WHERE index_artifact_id = ?').run(artifact);
  sql.prepare('DELETE FROM artifacts WHERE id = ?').run(artifact);
  const lines: Buffer[] = [];
  let at = 0;
  all.forEach((spec, entry) => {
    const text =
      spec.text === undefined
        ? `Synthetic ${spec.kind} text ${entry}`
        : spec.text;
    const key =
      spec.details.entry_key ??
      spec.details.entry_id ??
      `${spec.kind}:${entry}`;
    const details: Record<string, unknown> = {...spec.details, entry_key: key};
    const end = at + Array.from(text ?? '').length;
    const json =
      JSON.stringify({
        basis: {source, work: 'syn:work'},
        details,
        entry,
        label: String(details.entry_id ?? key),
        native_order: entry,
        provider: spec.provider ?? 'synthetic lexicon',
        reading_kind: text ? 'extracted' : 'gap',
        segments: [{unit_id: 'p000', start: at, end}],
        span_id: `${output}#entry${String(entry).padStart(4, '0')}`,
        text: text || null,
      }) + '\n';
    const line = Buffer.from(spec.edit ? spec.edit(json) : json);
    const lookup = details[LOOKUP[spec.kind]];
    sql
      .prepare('INSERT INTO aid_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        output,
        entry,
        spec.kind,
        String(key),
        typeof lookup === 'string' ? lookup : null,
        Buffer.concat(lines).length,
        line.length,
        sha(line),
      );
    lines.push(line);
    at = end + 1;
  });
  const body = Buffer.concat(lines);
  sql
    .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      artifact,
      source,
      output,
      sha(body),
      body.length,
      format,
      aidKey(output),
    );
  f.bucket.objects.set(aidKey(output), body);
  for (const kind of new Set(all.map(spec => spec.kind)))
    sql
      .prepare(
        `INSERT INTO coverage VALUES (?, ?, '{"unit_ids":["p000"]}', ?, 'available', 'syn:method/1', ?, '[]', NULL)`,
      )
      .run(output, source, kind, artifact);
}
