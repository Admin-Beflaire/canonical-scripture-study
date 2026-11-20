import { canonicalJson, isIdentifier, isSafeCount, utf8Length } from '../read/bytes.ts';
import { readSpans } from '../read/evidence.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError, limitation, type Limitation } from '../read/states.ts';
import { assembleBatch, ENVELOPE_RESERVE, type Batch, type EvidenceItem } from '../results/batch.ts';
import { encodeContinuation, resumeContinuation } from '../results/continuation.ts';

export const AID_LOOKUPS = ['lexicon', 'lexicon_entry', 'grammar_info'] as const;
type Position = [string, string, string];
export interface AidWorkload { mode: string; depth: string; language: string; lookup: string; key: string; sources: string[] | null }

/** A bounded, selected-release lookup. Alternatives remain separate and source-attributed. */
export async function aidBatch(session: ReadSession, input: AidWorkload, token: string | null,
  guidance: string, notes: Limitation[] = []): Promise<Batch> {
  if (!AID_LOOKUPS.includes(input.lookup as typeof AID_LOOKUPS[number]) || !isIdentifier(input.key, 256))
    throw new ReadError('invalid_request', 'Invalid language-aid lookup');
  if (input.sources && (!input.sources.length || input.sources.length > 20 || !input.sources.every(s => isIdentifier(s, 200))))
    throw new ReadError('invalid_request', 'Invalid source revisions');
  let key = input.key.trim();
  if (input.lookup === 'lexicon') {
    const match = key.match(/^([HG])(\d{1,5})$/i);
    if (!match) throw new ReadError('invalid_request', 'Use a Strong number such as H7307 or G3686');
    key = match[1].toUpperCase() + match[2].padStart(4, '0');
  }
  const workload = { ...input, key, sources: input.sources ? [...new Set(input.sources)].sort() : null };
  let after: Position = ['', '', ''];
  let offset = 0;
  let anchor: string | null = null;
  if (token) {
    const state = await resumeContinuation(token, workload, { aid: (pos, k) =>
      (pos === null || (!!pos && typeof pos === 'object' && !Array.isArray(pos)
        && Object.keys(pos).sort().join(',') === 'entry,offset'
        && isSafeCount((pos as {offset: unknown}).offset) && isIdentifier((pos as {entry: unknown}).entry)))
      && Array.isArray(k) && k.length === 3 && k.every(value => value === '' || isIdentifier(value)) });
    after = state.key as Position;
    if (state.pos) { const pos = state.pos as {offset: number; entry: string}; offset = pos.offset; anchor = pos.entry; }
  }
  const start = after;
  const query = input.lookup === 'lexicon' ? 'lexicon_strong' : input.lookup === 'lexicon_entry' ? 'lexicon_entry' : 'grammar_expansion';
  const page = await session.query(query, { key, after });
  if (anchor !== null && !page.rows.length) throw new ReadError('invalid_request', 'Continuation entry is no longer selected');
  const evidence: EvidenceItem[] = [];
  const limitations = [...notes];
  let remaining = false;
  session.budget.spendResult(ENVELOPE_RESERVE);
  for (const row of page.rows) {
    const position: Position = [String(row.output_id), String(row.span_id), String(row.id)];
    if (anchor !== null && String(row.id) !== anchor) throw new ReadError('invalid_request', 'Continuation no longer matches the selected entry');
    if (workload.sources && !workload.sources.includes(String(row.source_revision_id))) { after = position; continue; }
    let details: Record<string, unknown>;
    try { details = JSON.parse(String(row.details_json)); if (!details || Array.isArray(details) || typeof details !== 'object') throw new Error(); }
    catch { limitations.push(limitation('corrupt', String(row.span_id), 'Unreadable language-aid metadata')); after = position; continue; }
    // The Open Scriptures index records native BDB IDs. Construct only explicit links from
    // that index, using the same pinned edition; never equate entries by spelling.
    const indexId = typeof details.entry_id === 'string' ? details.entry_id.match(/^oshb-lexical-index:([0-9a-f]{40}):/) : null;
    if (indexId && Array.isArray(details.references)) {
      details.linked_entry_keys = [...new Set(details.references.flatMap(ref => Array.isArray(ref) && isIdentifier(ref[0], 200)
        ? [`oshb-bdb:${indexId[1]}:${ref[0]}`] : []))];
    }
    const read = await readSpans(session, [String(row.span_id)], true);
    if (read.remaining.length) { remaining = true; break; }
    limitations.push(...read.limitations);
    const span = read.spans[0];
    if (!span && anchor !== null) { anchor = null; offset = 0; }
    if (span) {
      if (span.text === null) limitations.push(limitation('missing_evidence', span.span_id, 'The source has no entry body here'));
      let item: EvidenceItem = { kind: 'language_aid', span, provider: String(row.provider), details };
      let bytes = utf8Length(canonicalJson(item));
      if (offset || !session.budget.canReturn(bytes)) {
        if (!span.text || span.text.length !== 1 || span.segments.length !== 1) {
          if (offset) throw new ReadError('invalid_request', 'Continuation does not match the entry');
          if (evidence.length) { remaining = true; break; }
          limitations.push(limitation('exceeds_limits', span.span_id, 'Entry cannot be divided within this request')); after = position; continue;
        }
        const chars = Array.from(span.text[0]);
        const segment = span.segments[0];
        if (segment.end - segment.start !== chars.length || offset >= chars.length)
          throw new ReadError('invalid_request', 'Continuation does not match entry coordinates');
        const fragment = (end: number): EvidenceItem => ({ kind: 'language_aid', provider: String(row.provider),
          details: { ...details, delivery_part: { start: offset, end, total: chars.length } },
          span: { ...span, text: [chars.slice(offset, end).join('')],
            segments: [{ ...segment, start: segment.start + offset, end: segment.start + end }] } });
        let low = offset, high = chars.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (session.budget.canReturn(utf8Length(canonicalJson(fragment(middle))))) low = middle;
          else high = middle - 1;
        }
        if (low === offset) {
          if (evidence.length) { remaining = true; break; }
          throw new ReadError('exceeds_limits', 'Entry metadata does not fit in one result');
        }
        item = fragment(low);
        bytes = utf8Length(canonicalJson(item));
        session.budget.spendResult(bytes);
        evidence.push(item);
        if (low < chars.length) { offset = low; anchor = String(row.id); remaining = true; break; }
        offset = 0; anchor = null;
      } else {
        session.budget.spendResult(bytes);
        evidence.push(item);
      }
    }
    after = position;
  }
  remaining ||= page.more;
  const continuation = remaining ? await encodeContinuation(workload, { op: 'aid', pos: anchor === null ? null : { offset, entry: anchor }, key: after }) : null;
  if (!token && !evidence.length && !remaining && !limitations.length)
    limitations.push(limitation('missing_evidence', key, 'No matching language aid is available in the selected release'));
  const assembled = assembleBatch({ release_id: session.release.id, mode: input.mode, depth: input.depth,
    delivered_scope: { lookup: input.lookup, key, sources: workload.sources, resumed_after: token ? start : null },
    context_scope: null, evidence, citations: evidence.flatMap(item => item.kind === 'language_aid'
      ? [{ source_revision_id: item.span.source_revision_id, span_id: item.span.span_id,
        coordinate_version: item.span.coordinate_version, segments: item.span.segments }] : []),
    searched_scope: [], coverage: [], limitations,
    remaining: remaining ? { lookup: input.lookup, key } : null, continuation, guidance_version: guidance,
    charged: new Set(evidence) }, session.budget);
  return assembled.batch;
}
