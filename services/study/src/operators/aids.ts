import {
  canonicalJson,
  isIdentifier,
  isSafeCount,
  utf8Length,
} from '../read/bytes.ts';
import {readAidEntries} from '../read/aid-entries.ts';
import type {ReadSession} from '../read/session.ts';
import {ReadError, limitation, type Limitation} from '../read/states.ts';
import {
  ENVELOPE_RESERVE,
  type Batch,
  type EvidenceItem,
} from '../results/batch.ts';
import {
  encodeContinuation,
  resumeContinuation,
} from '../results/continuation.ts';

export const AID_QUERIES = {
  lexicon: 'lexicon_strong',
  lexicon_entry: 'lexicon_entry',
  grammar_info: 'grammar_expansion',
  proper_name: 'proper_name',
} as const;
export type AidLookup = keyof typeof AID_QUERIES;
export const AID_LOOKUPS = Object.keys(AID_QUERIES) as AidLookup[];

/** Where a lookup stopped: the last output and entry delivered. */
type Position = [string, number];
export interface AidWorkload {
  mode: string;
  depth: string;
  language: string;
  lookup: string;
  key: string;
  sources: string[] | null;
}

export function normalizeAidKey(lookup: string, rawKey: string): string {
  if (!isIdentifier(rawKey, 256))
    throw new ReadError('invalid_request', 'Invalid language-aid lookup key');
  let key = rawKey.trim();
  if (lookup === 'lexicon') {
    const match = key.match(/^([HG])(\d{1,5})$/i);
    if (!match)
      throw new ReadError(
        'invalid_request',
        'Use a Strong number such as H7307 or G3686',
      );
    key = match[1].toUpperCase() + match[2].padStart(4, '0');
  }
  if (lookup === 'proper_name') {
    const match = key.match(/^([HG])(\d{1,5})([A-Z]?)$/i);
    if (!match)
      throw new ReadError(
        'invalid_request',
        'Use a disambiguated Strong tag, such as G2264G',
      );
    key = match[1].toUpperCase() + match[2].padStart(4, '0') + match[3];
  }
  return key;
}

interface AidBatchOptions {
  envelopeReserve?: number;
  finalize?: (batch: Batch) => void | Promise<void>;
}

type AidCursor = {after: Position; offset: number; anchor: number | null};
type AidEvidence = Extract<EvidenceItem, {kind: 'language_aid'}>;

/** A bounded, selected-release lookup. Alternatives remain separate and source-attributed. */
export async function aidBatch(
  session: ReadSession,
  input: AidWorkload,
  token: string | null,
  guidance: string,
  notes: Limitation[] = [],
  {envelopeReserve = ENVELOPE_RESERVE, finalize}: AidBatchOptions = {},
): Promise<Batch> {
  if (
    !AID_LOOKUPS.includes(input.lookup as (typeof AID_LOOKUPS)[number]) ||
    !isIdentifier(input.key, 256)
  )
    throw new ReadError('invalid_request', 'Invalid language-aid lookup');
  if (
    input.sources &&
    (!input.sources.length ||
      input.sources.length > 20 ||
      !input.sources.every(s => isIdentifier(s, 200)))
  )
    throw new ReadError('invalid_request', 'Invalid source revisions');
  const key = normalizeAidKey(input.lookup, input.key);
  const workload = {
    ...input,
    key,
    sources: input.sources ? [...new Set(input.sources)].sort() : null,
  };
  let after: Position = ['', -1];
  let offset = 0;
  let anchor: number | null = null;
  if (token) {
    const state = await resumeContinuation(token, workload, {
      aid: (pos, k) =>
        (pos === null ||
          (!!pos &&
            typeof pos === 'object' &&
            !Array.isArray(pos) &&
            Object.keys(pos).sort().join(',') === 'entry,offset' &&
            isSafeCount((pos as {offset: unknown}).offset) &&
            isSafeCount((pos as {entry: unknown}).entry))) &&
        Array.isArray(k) &&
        k.length === 2 &&
        (k[0] === '' || isIdentifier(k[0])) &&
        (k[1] === -1 || isSafeCount(k[1])),
    });
    after = state.key as Position;
    if (state.pos) {
      const pos = state.pos as {offset: number; entry: number};
      offset = pos.offset;
      anchor = pos.entry;
    }
  }
  const start = after;
  const query = AID_QUERIES[input.lookup as AidLookup];
  const page = await session.query(query, {key, after});
  if (anchor !== null && !page.rows.length)
    throw new ReadError(
      'invalid_request',
      'Continuation entry is no longer selected',
    );
  const evidence: AidEvidence[] = [];
  const limitations = [...notes];
  let remaining = false;
  const build = async (items: AidEvidence[], next: AidCursor | null) => {
    const batch = await makeAidBatch(
      session,
      workload,
      guidance,
      items,
      limitations,
      token ? start : null,
      next,
    );
    await finalize?.(batch);
    return batch;
  };
  const fits = async (
    item: AidEvidence,
    next: AidCursor | null,
    bytes = utf8Length(canonicalJson(item)),
  ) =>
    session.budget.canReturn(bytes) &&
    (!finalize ||
      utf8Length(JSON.stringify(await build([...evidence, item], next))) <=
        session.budget.limits.resultBytes);
  session.budget.spendResult(envelopeReserve);
  for (const [index, row] of page.rows.entries()) {
    const position: Position = [String(row.output_id), Number(row.entry)];
    if (anchor !== null && Number(row.entry) !== anchor)
      throw new ReadError(
        'invalid_request',
        'Continuation no longer matches the selected entry',
      );
    if (
      workload.sources &&
      !workload.sources.includes(String(row.source_revision_id))
    ) {
      after = position;
      continue;
    }
    const read = await readAidEntries(session, [row], true);
    if (read.remaining.length) {
      remaining = true;
      break;
    }
    limitations.push(...read.limitations);
    const found = read.entries[0];
    if (!found && anchor !== null) {
      anchor = null;
      offset = 0;
    }
    if (found) {
      const {span, details, provider} = found;
      if (span.text === null)
        limitations.push(
          limitation(
            'missing_evidence',
            span.span_id,
            'The source has no entry body here',
          ),
        );
      let item: AidEvidence = {kind: 'language_aid', span, provider, details};
      const nextRow =
        page.more || index + 1 < page.rows.length
          ? {after: position, offset: 0, anchor: null}
          : null;
      const fullBytes = utf8Length(canonicalJson(item));
      if (offset || !(await fits(item, nextRow, fullBytes))) {
        if (
          !span.text ||
          span.text.length !== 1 ||
          span.segments.length !== 1
        ) {
          if (offset)
            throw new ReadError(
              'invalid_request',
              'Continuation does not match the entry',
            );
          if (evidence.length || envelopeReserve === 0) {
            remaining = true;
            break;
          }
          limitations.push(
            limitation(
              'exceeds_limits',
              span.span_id,
              'Entry cannot be divided within this request',
            ),
          );
          after = position;
          continue;
        }
        const chars = Array.from(span.text[0]);
        const segment = span.segments[0];
        if (
          segment.end - segment.start !== chars.length ||
          offset >= chars.length
        )
          throw new ReadError(
            'invalid_request',
            'Continuation does not match entry coordinates',
          );
        const fragment = (end: number): AidEvidence => ({
          kind: 'language_aid',
          provider,
          details: {
            ...details,
            delivery_part: {start: offset, end, total: chars.length},
          },
          span: {
            ...span,
            text: [chars.slice(offset, end).join('')],
            segments: [
              {
                ...segment,
                start: segment.start + offset,
                end: segment.start + end,
              },
            ],
          },
        });
        let low = offset,
          high = chars.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          const next =
            middle < chars.length
              ? {after, offset: middle, anchor: Number(row.entry)}
              : nextRow;
          if (await fits(fragment(middle), next)) low = middle;
          else high = middle - 1;
        }
        if (low === offset) {
          if (evidence.length || envelopeReserve === 0) {
            remaining = true;
            break;
          }
          throw new ReadError(
            'exceeds_limits',
            'Entry metadata does not fit in one result',
          );
        }
        item = fragment(low);
        session.budget.spendResult(utf8Length(canonicalJson(item)));
        evidence.push(item);
        if (low < chars.length) {
          offset = low;
          anchor = Number(row.entry);
          remaining = true;
          break;
        }
        offset = 0;
        anchor = null;
      } else {
        session.budget.spendResult(fullBytes);
        evidence.push(item);
      }
    }
    after = position;
  }
  remaining ||= page.more;
  if (!token && !evidence.length && !remaining && !limitations.length)
    limitations.push(
      limitation(
        'missing_evidence',
        key,
        'No matching language aid is available in the selected release',
      ),
    );
  const batch = await build(
    evidence,
    remaining ? {after, offset, anchor} : null,
  );
  if (utf8Length(JSON.stringify(batch)) > session.budget.limits.resultBytes)
    throw new ReadError(
      'exceeds_limits',
      'The batch envelope does not fit the result allowance',
    );
  return batch;
}

async function makeAidBatch(
  session: ReadSession,
  workload: AidWorkload,
  guidance: string,
  evidence: AidEvidence[],
  limitations: Limitation[],
  start: Position | null,
  next: AidCursor | null,
): Promise<Batch> {
  const continuation = next
    ? await encodeContinuation(workload, {
        op: 'aid',
        pos:
          next.anchor === null
            ? null
            : {offset: next.offset, entry: next.anchor},
        key: next.after,
      })
    : null;
  const {mode, depth, lookup, key, sources} = workload;
  return {
    release_id: session.release.id,
    mode,
    depth,
    delivered_scope: {lookup, key, sources, resumed_after: start},
    context_scope: null,
    evidence,
    citations: evidence.map(({span}) => ({
      source_revision_id: span.source_revision_id,
      span_id: span.span_id,
      coordinate_version: span.coordinate_version,
      segments: span.segments,
    })),
    searched_scope: [],
    coverage: [],
    limitations: [...limitations],
    remaining: next ? {lookup, key} : null,
    continuation,
    guidance_version: guidance,
  };
}
