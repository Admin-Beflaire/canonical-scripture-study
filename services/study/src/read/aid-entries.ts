import {isIdentifier, isSafeCount} from './bytes.ts';
import {
  isObject,
  isSegments,
  rangeAllowance,
  type NativeSegment,
  type SpanEvidence,
} from './evidence.ts';
import {
  AID_ENTRIES_FORMAT,
  artifactFrom,
  readArtifact,
  readVerifiedRange,
} from './objects.ts';
import type {ReadSession} from './session.ts';
import {ReadError, limitation, type Limitation} from './states.ts';

/** A language-aid entry: its attributed wording as span evidence, its provider and its details. */
export interface AidEntry {
  span: SpanEvidence;
  provider: string;
  details: Record<string, unknown>;
}
export interface AidEntryRead {
  entries: AidEntry[];
  limitations: Limitation[];
  remaining: Record<string, unknown>[];
}
const READING_KINDS = ['extracted', 'gap'];

/** The Open Scriptures index records native BDB IDs. Only explicit links from that index are
 *  built, with the same pinned edition; entries are never equated by spelling. */
function withLinks(details: Record<string, unknown>): Record<string, unknown> {
  const index =
    typeof details.entry_id === 'string'
      ? details.entry_id.match(/^oshb-lexical-index:([0-9a-f]{40}):/)
      : null;
  if (index && Array.isArray(details.references))
    details.linked_entry_keys = [
      ...new Set(
        details.references.flatMap(ref =>
          Array.isArray(ref) && isIdentifier(ref[0], 200)
            ? [`oshb-bdb:${index[1]}:${ref[0]}`]
            : [],
        ),
      ),
    ];
  return details;
}

/** The span ID an entry's line carries: its output and its ordinal in the entries file. */
export const aidSpanId = (row: Record<string, unknown>) =>
  `${row.output_id}#entry${String(row.entry).padStart(4, '0')}`;

/** The fields every line has, in their expected types. */
function hasLineFields(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.label === 'string' &&
    typeof entry.provider === 'string' &&
    isSafeCount(entry.native_order) &&
    isSegments(entry.segments) &&
    (entry.segments as NativeSegment[]).length === 1 &&
    isObject(entry.basis) &&
    isObject(entry.details) &&
    READING_KINDS.includes(String(entry.reading_kind)) &&
    (entry.reading_kind === 'gap'
      ? entry.text === null
      : typeof entry.text === 'string')
  );
}

/** One verified line of an entries file, with the selected D1 row supplying source name,
 *  attribution, kind and coordinate version. A line that disagrees with its row is corrupt. */
export function parseAidLine(
  row: Record<string, unknown>,
  line: string,
): AidEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    value = undefined;
  }
  const entry = isObject(value) ? (value as Record<string, unknown>) : null;
  if (
    !entry ||
    !hasLineFields(entry) ||
    entry.entry !== row.entry ||
    entry.span_id !== aidSpanId(row) ||
    (entry.details as Record<string, unknown>).entry_key !== row.entry_key
  )
    throw new ReadError('corrupt', 'Inconsistent language-aid entry');
  const span: SpanEvidence = {
    span_id: aidSpanId(row),
    source_revision_id: String(row.source_revision_id),
    source_name: String(row.source_name),
    attribution: String(row.source_attribution),
    kind: String(row.kind),
    label: entry.label as string,
    native_order: entry.native_order as number,
    coordinate_version: String(row.coordinate_version),
    segments: entry.segments as NativeSegment[],
    basis: entry.basis as Record<string, unknown>,
    reading_kind: entry.reading_kind as string,
    text: typeof entry.text === 'string' ? [entry.text] : null,
  };
  return {
    span,
    provider: entry.provider as string,
    details: withLinks({...(entry.details as Record<string, unknown>)}),
  };
}

/** Reads and verifies the lines of selected entry rows (from the aid queries). Missing allowance
 *  leaves rows in `remaining`; a corrupt or unreadable line is reported and the others are returned. */
export async function readAidEntries(
  session: ReadSession,
  rows: Record<string, unknown>[],
  largeRanges = false,
): Promise<AidEntryRead> {
  const out: AidEntryRead = {entries: [], limitations: [], remaining: []};
  for (const row of rows) {
    try {
      if (row.format !== AID_ENTRIES_FORMAT)
        throw new ReadError(
          'corrupt',
          'Language-aid entries are not in an entries file',
        );
      if (
        !rangeAllowance(
          session,
          [Number(row.byte_length)],
          largeRanges,
          'entry',
        )
      ) {
        out.remaining.push(row);
        continue;
      }
      const range = {
        offset: Number(row.byte_offset),
        length: Number(row.byte_length),
        sha256: String(row.line_sha256),
      };
      const artifact = artifactFrom({
        id: row.artifact_id,
        sha256: row.sha256,
        byte_count: row.byte_count,
        format: row.format,
        registered_locator: row.registered_locator,
      });
      const line = largeRanges
        ? await readVerifiedRange(session, artifact, range)
        : await readArtifact(session, artifact, range);
      out.entries.push(parseAidLine(row, line));
    } catch (error) {
      if (!(error instanceof ReadError)) throw error;
      if (error.state === 'budget') {
        out.remaining.push(row);
        continue;
      }
      out.limitations.push(
        limitation(error.state, String(row.entry_key), error.message),
      );
    }
  }
  return out;
}
