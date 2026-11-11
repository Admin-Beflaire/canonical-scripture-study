/** Distinct read outcomes. A no-match is never reported as missing data, and a
 *  temporary failure or corruption is never reported as an empty result. */
export type ReadState =
  | 'no_current_release'     // nothing is selected
  | 'incompatible_release'   // the selected release uses formats this Study does not read
  | 'no_match'               // searched the stated extent and found nothing
  | 'missing_index'          // no selected index for this source/capability
  | 'incompatible_index'     // a selected index uses a format this Study does not read; rebuild needed
  | 'missing_evidence'       // a reference is not available in the current release
  | 'unresolved_mapping'     // an endpoint or correspondence exists but cannot be resolved here
  | 'unsupported_capability' // e.g. phrase, proximity or fuzzy lookup
  | 'corrupt'                // stored bytes or records fail their checks; withheld
  | 'temporary_failure'      // a provider read failed; retry may succeed
  | 'budget'                 // the request allowance is used; continue in another request
  | 'exceeds_limits'         // one stored item is larger than any request may read; withheld
  | 'invalid_request';       // malformed input or continuation

export class ReadError extends Error {
  readonly state: ReadState;
  constructor(state: ReadState, message: string) { super(message); this.name = 'ReadError'; this.state = state; }
}

export interface Limitation { state: ReadState; scope: string; detail: string }

export function limitation(state: ReadState, scope: string, detail: string): Limitation {
  return { state, scope, detail };
}
