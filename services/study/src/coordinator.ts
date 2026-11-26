import type {StudyReadEnvironment} from './read/bindings.ts';
import {ReadSession} from './read/session.ts';
import {limitsFor, type BudgetUsage, type ReadWorkload} from './read/budget.ts';
import {SUPPORTED_LOOKUPS, type LookupKind} from './read/search.ts';
import {ReadError, limitation, type Limitation} from './read/states.ts';
import type {Batch} from './results/batch.ts';
import {GUIDANCE_VERSION} from './guidance.ts';
import {
  EVIDENCE_FOCUS,
  languageBatch,
  type EvidenceFocus,
} from './operators/language.ts';
import {nameStudyBatch} from './operators/name-study.ts';
import {aidBatch, AID_LOOKUPS} from './operators/aids.ts';
import {passageBatch} from './operators/passage.ts';

export const MODES = [
  'translation',
  'passage',
  'exegesis',
  'comparison',
  'word_analysis',
  'word_study',
  'theme',
  'inspect_source',
  'conclusion_check',
] as const;
export type Mode = (typeof MODES)[number];
export const DEPTHS = ['focused', 'standard', 'comprehensive'] as const;

export interface SearchLead {
  lookup: string;
  key: string;
}
/** The `study` tool input (Study To-Be §2). */
export interface StudyRequest {
  mode: Mode;
  question?: string;
  depth?: string;
  language?: string;
  references?: string[];
  search_leads?: SearchLead[];
  sources?: string[];
  requested_result?: string;
  interactive?: boolean;
  continuation?: string;
  focus?: EvidenceFocus;
}

/** What this version cannot supply, stated rather than returned as an empty result. */
const NOT_OFFERED: Partial<Record<Mode, Limitation[]>> = {
  comparison: [
    limitation(
      'unsupported_capability',
      'comparison',
      'No manuscript or witness relationships are offered yet. Reader mappings retain native citations; verses with the same number are not assumed to correspond without checked mappings.',
    ),
  ],
  theme: [
    limitation(
      'unsupported_capability',
      'discovery',
      'Commentary, background and quotation/allusion search are not offered yet; only exact word, form, lemma and grammar search over the original texts.',
    ),
  ],
  word_analysis: [
    limitation(
      'unsupported_capability',
      'word_analysis',
      'Word-by-word analysis of a whole passage is not indexed yet. Search a word, form or lemma to get each occurrence with its attributed analyses.',
    ),
  ],
  exegesis: [
    limitation(
      'unsupported_capability',
      'discovery',
      'Commentary and background search are not offered yet.',
    ),
  ],
};

function checkRequest(request: StudyRequest) {
  if (!request || typeof request !== 'object')
    throw new ReadError('invalid_request', 'Missing study request');
  if (!MODES.includes(request.mode))
    throw new ReadError(
      'invalid_request',
      `Unknown mode; use one of ${MODES.join(', ')}`,
    );
  if (
    request.depth !== undefined &&
    !DEPTHS.includes(request.depth as (typeof DEPTHS)[number])
  )
    throw new ReadError(
      'invalid_request',
      `Unknown depth; use ${DEPTHS.join(', ')}`,
    );
  if (request.focus !== undefined && !EVIDENCE_FOCUS.includes(request.focus))
    throw new ReadError(
      'invalid_request',
      `Unknown focus; use ${EVIDENCE_FOCUS.join(', ')}`,
    );
}

/** Error batch: the request could not be served. The state says why (never an empty success). */
export function failure(
  error: ReadError,
  request: StudyRequest,
): Record<string, unknown> {
  return {
    mode: request?.mode ?? null,
    evidence: [],
    limitations: [limitation(error.state, 'request', error.message)],
    continuation: null,
    guidance_version: GUIDANCE_VERSION,
  };
}

/** What a request asks to read: passage references, or else a search lead. */
interface Asked {
  references: string[];
  leads: SearchLead[];
}

function asked(request: StudyRequest): Asked {
  const references =
    request.references?.filter(r => typeof r === 'string' && r.trim()) ?? [];
  const leads = request.search_leads ?? [];
  if (
    request.mode !== 'conclusion_check' &&
    !references.length &&
    !leads.length
  )
    throw new ReadError(
      'invalid_request',
      'Give references (for passages) or search_leads (for words); for example references ["Gen 1:1-2:3"] or search_leads [{"lookup":"lemma","key":"H7225"}]',
    );
  return {references, leads};
}

/** Which read allowance the request draws on. */
function readKind({references, leads}: Asked): ReadWorkload {
  if (references.length || leads.length !== 1) return 'passage';
  const lookup = leads[0]?.lookup;
  if (AID_LOOKUPS.includes(lookup as (typeof AID_LOOKUPS)[number]))
    return 'aid';
  return SUPPORTED_LOOKUPS.includes(lookup as LookupKind) ? 'word' : 'passage';
}

const baseOf = (request: StudyRequest) => ({
  mode: request.mode,
  depth: request.depth ?? 'standard',
  language: request.language ?? 'en',
});

/** Routes one study request to its operator and returns one bounded batch. Passage references
 *  are read first; otherwise the first search lead is searched. The coordinator routes reads;
 *  it never produces an interpretation. */
export async function study(
  env: StudyReadEnvironment,
  request: StudyRequest,
  reportUsage?: (usage: BudgetUsage) => void,
): Promise<Batch | Record<string, unknown>> {
  let session: ReadSession | undefined;
  try {
    checkRequest(request);
    const wanted = asked(request);
    session = await ReadSession.open(env, limitsFor(env, readKind(wanted)));
    if (request.mode === 'conclusion_check')
      return await conclusionCheck(session, baseOf(request));
    return await evidenceBatch(session, request, wanted);
  } catch (error) {
    if (error instanceof ReadError) return failure(error, request);
    throw error;
  } finally {
    if (session) reportUsage?.(session.budget.usage());
  }
}

/** Reads the passages, or else searches the first lead. */
async function evidenceBatch(
  session: ReadSession,
  request: StudyRequest,
  {references, leads}: Asked,
): Promise<Batch> {
  const mode = request.mode;
  const base = baseOf(request);
  const continuation = request.continuation ?? null;
  // Notes go in before the batch is sized, so the whole envelope stays within the result cap.
  // Only on the first batch, so a continued study does not repeat them.
  const notes: Limitation[] = continuation
    ? []
    : [...(NOT_OFFERED[mode] ?? [])];
  if (!references.length)
    return searchLead(session, request, base, leads, continuation, notes);
  if (leads.length && !continuation)
    notes.push(
      limitation(
        'invalid_request',
        'search_leads',
        'Search leads are not run together with references; call study again with the leads alone',
      ),
    );
  return passageBatch(
    session,
    {
      ...base,
      references,
      sources: request.sources ?? null,
      context: mode !== 'inspect_source' && request.depth !== 'focused',
    },
    continuation,
    GUIDANCE_VERSION,
    notes,
  );
}

function searchLead(
  session: ReadSession,
  request: StudyRequest,
  base: {mode: Mode; depth: string; language: string},
  leads: SearchLead[],
  continuation: string | null,
  notes: Limitation[],
): Promise<Batch> {
  if (leads.length > 1)
    throw new ReadError('invalid_request', 'Give one search lead per call');
  const lead = leads[0];
  if (!lead || typeof lead !== 'object')
    throw new ReadError('invalid_request', 'A search lead is {lookup, key}');
  const workload = {
    ...base,
    lookup: lead.lookup,
    key: lead.key,
    sources: request.sources ?? null,
    focus: request.focus,
  };
  if (
    lead.lookup === 'proper_name' &&
    !request.sources &&
    (base.mode === 'word_study' || base.mode === 'word_analysis')
  )
    return nameStudyBatch(
      session,
      workload,
      continuation,
      GUIDANCE_VERSION,
      notes,
    );
  const batch = AID_LOOKUPS.includes(
    lead.lookup as (typeof AID_LOOKUPS)[number],
  )
    ? aidBatch
    : languageBatch;
  return batch(session, workload, continuation, GUIDANCE_VERSION, notes);
}

/** The selected approved statement and its scriptural basis, or its explicit absence. It checks
 *  conclusions after interpretation and never supplies a premise. */
async function conclusionCheck(
  session: ReadSession,
  base: {mode: string; depth: string; language: string},
) {
  const {rows} = await session.query('statement', {} as never);
  const statement = rows[0];
  return {
    release_id: session.release.id,
    ...base,
    statement: statement
      ? {
          name: String(statement.name),
          version: String(statement.version),
          scripture_basis: (() => {
            try {
              return JSON.parse(String(statement.scripture_basis_json));
            } catch {
              return null;
            }
          })(),
        }
      : null,
    limitations: statement
      ? []
      : [
          limitation(
            'missing_evidence',
            'statement',
            'No approved character-of-God statement is selected. Ordinary sources remain usable.',
          ),
        ],
    continuation: null,
    guidance_version: GUIDANCE_VERSION,
  };
}
