import { compareUtf8 } from '../read/bytes.ts';
import { checkRequest, type SearchAdapter, type SearchPosition } from '../read/search.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError } from '../read/states.ts';
import { assembleBatch, type Batch, type EvidenceItem } from './batch.ts';
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
    if (!pos || typeof pos !== 'object' || Array.isArray(pos) || JSON.stringify(Object.keys(pos).sort()) !== '["file","output","page","source"]') return false;
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
  const result = await adapter.search(session, { lookup: normalized.lookup, key: normalized.key, sources: normalized.sources, position });
  const evidence: EvidenceItem[] = result.hits.map(hit => ({ kind: 'search_hit', hit, lookup: result.lookup, key: result.key }));
  const next = result.remaining ? await encodeContinuation(normalized, { op: 'search',
    pos: { source: result.remaining.source, output: result.remaining.output, file: result.remaining.file, page: result.remaining.page },
    key: result.remaining.after }) : null;
  const { batch } = assembleBatch({
    release_id: session.release.id, mode: normalized.mode, depth: normalized.depth,
    delivered_scope: { lookup: normalized.lookup, key: normalized.key, sources: normalized.sources }, context_scope: null,
    evidence, citations: [], searched_scope: result.searched,
    coverage: result.searched.map(s => ({ source_revision_id: s.source_revision_id, capability: s.capability, state: s.coverage_state, limitation: null })),
    limitations: result.limitations, remaining: result.remaining ? { search: result.state, from_source: result.remaining.source } : null,
    continuation: next, guidance_version: guidanceVersion, charged: new Set(evidence),
  }, session.budget);
  return batch;
}
