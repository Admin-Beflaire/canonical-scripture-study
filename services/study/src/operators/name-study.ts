import {utf8Length} from '../read/bytes.ts';
import {PagedIndexSearch} from '../read/search.ts';
import type {ReadSession} from '../read/session.ts';
import {ReadError, type Limitation} from '../read/states.ts';
import {
  encodeContinuation,
  resumeContinuation,
} from '../results/continuation.ts';
import {searchBatch} from '../results/search-batch.ts';
import {aidBatch, normalizeAidKey} from './aids.ts';
import {sourcesWith, type LanguageWorkload} from './language.ts';

type Stage = 'names' | 'occurrences';

const NAME_STUDY_CHECKS = {
  names: validPosition,
  occurrences: validPosition,
};

function validPosition(position: unknown, key: unknown): boolean {
  return (
    key === null &&
    (position === null ||
      (typeof position === 'string' && /^[\w-]{1,2048}$/.test(position)))
  );
}

/** Identity candidates and exact full-tag occurrences are two steps in one Study request. */
export async function nameStudyBatch(
  session: ReadSession,
  input: LanguageWorkload,
  continuation: string | null,
  guidance: string,
  notes: Limitation[],
) {
  const workload = {...input, key: normalizeAidKey('proper_name', input.key)};
  const state = continuation
    ? await resumeContinuation(continuation, workload, NAME_STUDY_CHECKS)
    : null;
  const first: Stage =
    workload.focus === 'occurrences' ? 'occurrences' : 'names';
  const stage = (state?.op ?? first) as Stage;
  const token = (state?.pos as string | null) ?? null;
  const batch =
    stage === 'names'
      ? await aidBatch(session, workload, token, guidance, notes)
      : await nameOccurrences(session, workload, token, guidance, notes);
  const remainingStage = batch.continuation
    ? stage
    : stage === first
      ? first === 'names'
        ? 'occurrences'
        : 'names'
      : null;
  if (remainingStage) {
    batch.continuation = await encodeContinuation(workload, {
      op: remainingStage,
      pos: batch.continuation,
      key: null,
    });
    batch.remaining = {stage: remainingStage};
  }
  if (utf8Length(JSON.stringify(batch)) > session.budget.limits.resultBytes)
    throw new ReadError('exceeds_limits', 'Name study batch does not fit');
  return batch;
}

async function nameOccurrences(
  session: ReadSession,
  workload: LanguageWorkload,
  token: string | null,
  guidance: string,
  notes: Limitation[],
) {
  const sources = await sourcesWith(session, 'lemma_exact');
  if (!sources.length) {
    return {
      release_id: session.release.id,
      mode: workload.mode,
      depth: workload.depth,
      delivered_scope: {lookup: 'lemma', key: workload.key, sources},
      context_scope: null,
      evidence: [],
      citations: [],
      searched_scope: [],
      coverage: [],
      limitations: [
        ...notes,
        {
          state: 'missing_index' as const,
          scope: 'lemma',
          detail: 'No selected source offers lemma search',
        },
      ],
      remaining: null,
      continuation: null,
      guidance_version: guidance,
    };
  }
  return searchBatch(
    session,
    new PagedIndexSearch(),
    {...workload, lookup: 'lemma', sources},
    token,
    guidance,
    notes,
  );
}
