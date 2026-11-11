import { canonicalJson, utf8Length } from '../read/bytes.ts';
import type { RequestBudget } from '../read/budget.ts';
import type { NativeSegment, SpanEvidence } from '../read/evidence.ts';
import type { SearchedScope, SearchHit } from '../read/search.ts';
import { limitation, type Limitation } from '../read/states.ts';

/** One attributed piece of evidence. Equal wording from different sources stays separate. */
export type EvidenceItem =
  | { kind: 'source_text'; span: SpanEvidence }
  | { kind: 'search_hit'; hit: SearchHit; lookup: string; key: string };

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

/** Builds a batch within the result allowance. Evidence that does not fit is returned in
 *  `deferred` (never silently dropped) so the caller can continue it. */
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
  const { charged: _charged, ...rest } = input;
  return { batch: { ...rest, evidence, citations, limitations }, deferred };
}
