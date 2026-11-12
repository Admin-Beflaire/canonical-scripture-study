import { compareUtf8, utf8Length } from '../read/bytes.ts';
import { checkRequest, type SearchAdapter, type SearchPosition } from '../read/search.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError, limitation } from '../read/states.ts';
import { ENVELOPE_RESERVE, type Batch, type EvidenceItem } from './batch.ts';
import { encodeContinuation, resumeContinuation, type PositionCheck } from './continuation.ts';

/** The search part of a Study workload, as an operator supplies it. */
export interface SearchWorkload { mode: string; depth: string; language: string; lookup: string; key: string; sources: string[] }

export function normalizeSearchWorkload(w: SearchWorkload): SearchWorkload {
  const checked = checkRequest({ lookup: w?.lookup, key: w?.key, sources: w?.sources });
  for (const field of ['mode', 'depth', 'language'] as const)
    if (typeof w[field] !== 'string' || w[field].length < 1 || w[field].length > 64) throw new ReadError('invalid_request', `Invalid ${field}`);
  return { mode: w.mode, depth: w.depth, language: w.language, lookup: checked.lookup, key: checked.key, sources: [...checked.sources].sort(compareUtf8) };
}

/** A search position is valid only for the submitted workload's sources and within the
 *  adapter's position bounds; the adapter re-checks it against the selected index. */
export const SEARCH_CHECKS: Readonly<Record<string, PositionCheck>> = Object.freeze({
  search(pos: unknown, key: unknown, workload: unknown) {
    if (!pos || typeof pos !== 'object' || Array.isArray(pos) || JSON.stringify(Object.keys(pos).sort()) !== '["anchor","dir","entry","order","output","source"]') return false;
    const w = workload as SearchWorkload;
    try { checkRequest({ lookup: w.lookup, key: w.key, sources: w.sources, position: { ...(pos as Omit<SearchPosition, 'after'>), after: key as SearchPosition['after'] } }); }
    catch { return false; }
    return true;
  },
});

/** One bounded search batch. Works with any adapter that honours the search contract. */
export async function searchBatch(session: ReadSession, adapter: SearchAdapter, workload: SearchWorkload,
                                  continuation: string | null, guidanceVersion: string): Promise<Batch> {
  const normalized = normalizeSearchWorkload(workload);
  let position: SearchPosition | null = null;
  if (continuation !== null) {
    const state = await resumeContinuation(continuation, normalized, SEARCH_CHECKS);
    position = { ...(state.pos as Omit<SearchPosition, 'after'>), after: state.key as SearchPosition['after'] };
  }
  // Keep room for the envelope; the adapter charges each hit as the batch wraps it (`hitBytes`).
  session.budget.spendResult(ENVELOPE_RESERVE);
  const result = await adapter.search(session, { lookup: normalized.lookup, key: normalized.key, sources: normalized.sources, position });
  if (result.resume_after.length !== result.hits.length) throw new ReadError('corrupt', 'Search adapter broke its result contract');
  const build = async (count: number): Promise<Batch> => {
    // Delivering only the first `count` hits resumes after the last one delivered.
    const remaining = count < result.hits.length ? result.resume_after[count - 1] : result.remaining;
    const evidence: EvidenceItem[] = result.hits.slice(0, count).map(hit => ({ kind: 'search_hit', hit }));
    const next = remaining ? await encodeContinuation(normalized, { op: 'search',
      pos: { source: remaining.source, output: remaining.output, order: remaining.order, dir: remaining.dir, entry: remaining.entry, anchor: remaining.anchor },
      key: remaining.after }) : null;
    return {
      release_id: session.release.id, mode: normalized.mode, depth: normalized.depth,
      delivered_scope: { lookup: normalized.lookup, key: normalized.key, sources: normalized.sources }, context_scope: null,
      evidence, citations: [], searched_scope: result.searched,
      coverage: result.searched.map(s => ({ source_revision_id: s.source_revision_id, capability: s.capability, state: s.coverage_state, limitation: null })),
      limitations: count < result.hits.length
        ? [...result.limitations, limitation('budget', 'evidence', `${result.hits.length - count} occurrence(s) continue in the next batch`)]
        : result.limitations,
      remaining: remaining ? { search: count < result.hits.length ? 'continues' : result.state, from_source: remaining.source } : null,
      continuation: next, guidance_version: guidanceVersion,
    };
  };
  // The envelope (scopes, limitations, continuation) can outgrow its reserve; then deliver fewer
  // hits and continue after the last one delivered, rather than failing the whole batch.
  let count = result.hits.length;
  let batch = await build(count);
  while (utf8Length(JSON.stringify(batch)) > session.budget.limits.resultBytes) {
    // At least one hit must remain, or the next request would start where this one did.
    if (count <= 1) throw new ReadError('exceeds_limits', 'The batch envelope does not fit the result allowance');
    count -= 1;
    batch = await build(count);
  }
  return batch;
}
