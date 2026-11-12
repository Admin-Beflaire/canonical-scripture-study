import { canonicalJson, utf8Length } from '../read/bytes.ts';
import type { RequestBudget } from '../read/budget.ts';
import type { NativeSegment, SpanEvidence } from '../read/evidence.ts';
import type { SearchedScope, SearchHit } from '../read/search.ts';
import { ReadError, limitation, type Limitation } from '../read/states.ts';

/** One attributed piece of evidence. Equal wording from different sources stays separate. */
export type EvidenceItem =
  | { kind: 'source_text'; span: SpanEvidence; role?: 'requested' | 'context'; annotations?: PassageAnnotation[] }
  | { kind: 'search_hit'; hit: SearchHit };

/** A recorded note on a verse (for example textual variants), attributed to its provider. */
export interface PassageAnnotation { kind: string; provider: string; details: Record<string, unknown> }

export interface Citation { source_revision_id: string; span_id: string; coordinate_version: string; segments: NativeSegment[]; quote?: string }

export interface CoverageNote { source_revision_id: string; capability: string; state: string; limitation: string | null }

/** The Study batch envelope (Study To-Be §5). Batch completion is not retrieval exhaustion,
 *  and neither is delivery of the study; `remaining` and `continuation` say what is left. */
export interface Batch {
  release_id: string; mode: string; depth: string; delivered_scope: unknown; context_scope: unknown;
  evidence: EvidenceItem[]; citations: Citation[]; searched_scope: SearchedScope[]; coverage: CoverageNote[];
  limitations: Limitation[]; remaining: unknown; continuation: string | null; guidance_version: string;
}

export interface BatchInput extends Omit<Batch, 'evidence' | 'citations' | 'limitations'> {
  evidence: EvidenceItem[]; citations: Citation[]; limitations: Limitation[];
  /** Evidence already charged to the result allowance (e.g. search hits). */
  charged?: ReadonlySet<EvidenceItem>;
}

function sameSegments(a: NativeSegment[], b: NativeSegment[]) {
  return a.length === b.length && a.every((s, i) => s.unit_id === b[i].unit_id && s.start === b[i].start && s.end === b[i].end);
}
function within(outer: NativeSegment[], inner: NativeSegment[]) {
  return inner.every(s => outer.some(o => o.unit_id === s.unit_id && o.start <= s.start && s.end <= o.end));
}

/** A citation is kept only if it points to evidence in this batch with the same source,
 *  span and coordinates, and any quote appears in that span's selected wording. */
function supported(citation: Citation, evidence: EvidenceItem[]): boolean {
  return evidence.some(item => {
    if (item.kind === 'source_text') {
      const s = item.span;
      return s.source_revision_id === citation.source_revision_id && s.span_id === citation.span_id
        && s.coordinate_version === citation.coordinate_version && within(s.segments, citation.segments)
        && (citation.quote === undefined || (s.text ?? []).some(t => t.includes(citation.quote!)));
    }
    const h = item.hit;
    return citation.quote === undefined && h.source_revision_id === citation.source_revision_id && h.span_id === citation.span_id
      && h.coordinate_version === citation.coordinate_version && sameSegments(h.native_reference.segments, citation.segments);
  });
}

/** Room kept for everything in a batch except evidence: scopes, coverage, limitations,
 *  citations and the continuation. Callers that charge evidence early reserve it first. */
export const ENVELOPE_RESERVE = 4096;

const serialized = (batch: Batch) => utf8Length(JSON.stringify(batch));

/** Builds a batch whose complete serialized form fits `resultBytes`. Evidence that does not fit
 *  is returned in `deferred` (never silently dropped) so the caller can continue it. Charged
 *  evidence is never deferred; if the batch still cannot fit, nothing is returned. */
export function assembleBatch(input: BatchInput, budget: RequestBudget): { batch: Batch; deferred: EvidenceItem[] } {
  const evidence: EvidenceItem[] = [];
  const deferred: EvidenceItem[] = [];
  for (const item of input.evidence) {
    if (input.charged?.has(item)) { evidence.push(item); continue; }
    if (deferred.length) { deferred.push(item); continue; }   // keep native order: no later item jumps ahead
    const bytes = utf8Length(canonicalJson(item));
    if (budget.canReturn(bytes)) { budget.spendResult(bytes); evidence.push(item); } else deferred.push(item);
  }
  const limitations = [...input.limitations];
  if (deferred.length) limitations.push(limitation('budget', 'evidence', `${deferred.length} item(s) continue in the next batch`));
  const citations = input.citations.filter(c => supported(c, evidence));
  if (citations.length !== input.citations.length)
    limitations.push(limitation('invalid_request', 'citations', `${input.citations.length - citations.length} citation(s) did not match supplied evidence and were removed`));
  const { charged, ...rest } = input;
  const batch: Batch = { ...rest, evidence, citations, limitations };
  // Final guard on the whole envelope, not only on evidence items.
  while (serialized(batch) > budget.limits.resultBytes) {
    const at = batch.evidence.findLastIndex(item => !charged?.has(item));
    if (at < 0) throw new ReadError('exceeds_limits', 'The batch envelope does not fit the result allowance');
    deferred.unshift(...batch.evidence.splice(at, 1));   // charged evidence is never deferred
    batch.citations = batch.citations.filter(c => supported(c, batch.evidence));
    if (!batch.limitations.some(l => l.state === 'budget' && l.scope === 'evidence'))
      batch.limitations.push(limitation('budget', 'evidence', 'Some items continue in the next batch'));
  }
  return { batch, deferred };
}
