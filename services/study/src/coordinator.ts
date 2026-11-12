import type { StudyReadEnvironment } from './read/bindings.ts';
import { ReadSession } from './read/session.ts';
import { ReadError, limitation, type Limitation } from './read/states.ts';
import type { Batch } from './results/batch.ts';
import { GUIDANCE_VERSION, TRANSLATION_RULES } from './guidance.ts';
import { languageBatch } from './operators/language.ts';
import { passageBatch } from './operators/passage.ts';

export const MODES = ['translation', 'passage', 'exegesis', 'comparison', 'word_analysis', 'word_study', 'theme', 'inspect_source', 'conclusion_check'] as const;
export type Mode = typeof MODES[number];
export const DEPTHS = ['focused', 'standard', 'comprehensive'] as const;

export interface SearchLead { lookup: string; key: string }
/** The `study` tool input (Study To-Be §2). */
export interface StudyRequest {
  mode: Mode; question?: string; depth?: string; language?: string; references?: string[]; search_leads?: SearchLead[];
  sources?: string[]; requested_result?: string; interactive?: boolean; continuation?: string;
}

/** Modes whose answer includes a translation: their first batch carries the key translation rules. */
const TRANSLATING = new Set<Mode>(['translation', 'passage', 'exegesis', 'comparison']);

/** What this version cannot supply, stated rather than returned as an empty result. */
const NOT_OFFERED: Partial<Record<Mode, Limitation[]>> = {
  comparison: [limitation('unsupported_capability', 'comparison', 'No manuscript or witness relationships are offered yet. Each source is returned in its own numbering; verses with the same number are not assumed to correspond.')],
  theme: [limitation('unsupported_capability', 'discovery', 'Commentary, background and quotation/allusion search are not offered yet; only exact word, form, lemma and grammar search over the original texts.')],
  word_analysis: [limitation('unsupported_capability', 'word_analysis', 'Word-by-word analysis of a whole passage is not indexed yet. Search a word, form or lemma to get each occurrence with its attributed analyses.')],
  exegesis: [limitation('unsupported_capability', 'discovery', 'Commentary and background search are not offered yet.')],
};

function checkRequest(request: StudyRequest) {
  if (!request || typeof request !== 'object') throw new ReadError('invalid_request', 'Missing study request');
  if (!MODES.includes(request.mode)) throw new ReadError('invalid_request', `Unknown mode; use one of ${MODES.join(', ')}`);
  if (request.depth !== undefined && !DEPTHS.includes(request.depth as typeof DEPTHS[number])) throw new ReadError('invalid_request', `Unknown depth; use ${DEPTHS.join(', ')}`);
}

/** Error batch: the request could not be served. The state says why (never an empty success). */
function failure(error: ReadError, request: StudyRequest): Record<string, unknown> {
  return { mode: request?.mode ?? null, evidence: [], limitations: [limitation(error.state, 'request', error.message)], continuation: null, guidance_version: GUIDANCE_VERSION };
}

/** Routes one study request to its operator and returns one bounded batch. Passage references
 *  are read first; otherwise the first search lead is searched. The coordinator routes reads;
 *  it never produces an interpretation. */
export async function study(env: StudyReadEnvironment, request: StudyRequest): Promise<Batch | Record<string, unknown>> {
  try {
    checkRequest(request);
    const mode = request.mode;
    const base = { mode, depth: request.depth ?? 'standard', language: request.language ?? 'en' };
    const continuation = request.continuation ?? null;
    const refs = request.references?.filter(r => typeof r === 'string' && r.trim()) ?? [];
    const leads = request.search_leads ?? [];
    if (mode === 'conclusion_check') return await conclusionCheck(env, base);
    if (!refs.length && !leads.length)
      throw new ReadError('invalid_request', 'Give references (for passages) or search_leads (for words); for example references ["Gen 1:1-2:3"] or search_leads [{"lookup":"lemma","key":"H7225"}]');
    const session = await ReadSession.open(env);
    // Notes go in before the batch is sized, so the whole envelope stays within the result cap.
    // Only on the first batch, so a continued study does not repeat them.
    const notes: Limitation[] = continuation ? [] : [...(NOT_OFFERED[mode] ?? [])];
    let batch: Batch;
    if (refs.length) {
      if (leads.length && !continuation) notes.push(limitation('invalid_request', 'search_leads', 'Search leads are not run together with references; call study again with the leads alone'));
      batch = await passageBatch(session, { ...base, references: refs, sources: request.sources ?? null,
        context: mode !== 'inspect_source' && request.depth !== 'focused' }, continuation, GUIDANCE_VERSION, notes,
        !continuation && TRANSLATING.has(mode) ? TRANSLATION_RULES : null);
    } else {
      if (leads.length > 1) throw new ReadError('invalid_request', 'Give one search lead per call');
      const lead = leads[0];
      if (!lead || typeof lead !== 'object') throw new ReadError('invalid_request', 'A search lead is {lookup, key}');
      batch = await languageBatch(session, { ...base, lookup: lead.lookup, key: lead.key, sources: request.sources ?? null }, continuation, GUIDANCE_VERSION, notes);
    }
    return batch;
  } catch (error) {
    if (error instanceof ReadError) return failure(error, request);
    throw error;
  }
}

/** The selected approved statement and its scriptural basis, or its explicit absence. It checks
 *  conclusions after interpretation and never supplies a premise. */
async function conclusionCheck(env: StudyReadEnvironment, base: { mode: string; depth: string; language: string }) {
  const session = await ReadSession.open(env);
  const { rows } = await session.query('statement', {} as never);
  const statement = rows[0];
  return {
    release_id: session.release.id, ...base,
    statement: statement ? { name: String(statement.name), version: String(statement.version),
      scripture_basis: (() => { try { return JSON.parse(String(statement.scripture_basis_json)); } catch { return null; } })() } : null,
    limitations: statement ? [] : [limitation('missing_evidence', 'statement', 'No approved character-of-God statement is selected. Ordinary sources remain usable; the conclusion is checked against Scripture only.')],
    note: 'The statement checks a conclusion after interpretation; it is not a premise, and agreement proves nothing.',
    continuation: null, guidance_version: GUIDANCE_VERSION,
  };
}
