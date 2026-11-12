/** Study's protected read adapter (Study To-Be §1, §4). Operators use only these exports;
 *  D1 statements, R2 object keys and the index page format stay inside this module. */
export { ReadSession, SUPPORTED_SCHEMA_VERSIONS, type CurrentRelease } from './session.ts';
export { RequestBudget, STARTING_LIMITS, limitsFor, type BudgetLimits, type BudgetUsage } from './budget.ts';
export { readSpans, readRelationships, type SpanEvidence, type SpanRead, type NativeSegment, type RelationshipEvidence, type RelationshipMember } from './evidence.ts';
export { PagedIndexSearch, SUPPORTED_LOOKUPS, UNSUPPORTED_LOOKUPS, checkRequest, type SearchAdapter, type SearchRequest,
  type SearchResult, type SearchHit, type SearchPosition, type SearchedScope, type SearchState, type LookupKind } from './search.ts';
export { ReadError, limitation, type Limitation, type ReadState } from './states.ts';
export type { StudyReadEnvironment } from './bindings.ts';
export type { QueryName, QueryInput } from './queries.ts';
