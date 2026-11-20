import { canonicalJson, isIdentifier, utf8Length } from '../read/bytes.ts';
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
  if (token) {
    const state = await resumeContinuation(token, workload, { aid: (pos, k) => pos === null && Array.isArray(k) && k.length === 3
      && k.every(value => value === '' || isIdentifier(value)) });
    after = state.key as Position;
  }
  const start = after;
  const query = input.lookup === 'lexicon' ? 'lexicon_strong' : input.lookup === 'lexicon_entry' ? 'lexicon_entry' : 'grammar_expansion';
  const page = await session.query(query, { key, after });
  const evidence: EvidenceItem[] = [];
  const limitations = [...notes];
  let remaining = false;
  session.budget.spendResult(ENVELOPE_RESERVE);
  for (const row of page.rows) {
    const position: Position = [String(row.output_id), String(row.span_id), String(row.id)];
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
    const read = await readSpans(session, [String(row.span_id)]);
    if (read.remaining.length) { remaining = true; break; }
    limitations.push(...read.limitations);
    const span = read.spans[0];
    if (span) {
      if (span.text === null) limitations.push(limitation('missing_evidence', span.span_id, 'The source has no entry body here'));
      const item: EvidenceItem = { kind: 'language_aid', span, provider: String(row.provider), details };
      const bytes = utf8Length(canonicalJson(item));
      if (!session.budget.canReturn(bytes)) {
        if (!evidence.length) { limitations.push(limitation('exceeds_limits', span.span_id, 'Entry does not fit in one result')); after = position; continue; }
        remaining = true; break;
      }
      session.budget.spendResult(bytes);
      evidence.push(item);
    }
    after = position;
  }
  remaining ||= page.more;
  const continuation = remaining ? await encodeContinuation(workload, { op: 'aid', pos: null, key: after }) : null;
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
