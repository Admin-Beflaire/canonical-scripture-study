import { compareUtf8, isIdentifier } from '../read/bytes.ts';
import { PagedIndexSearch, SUPPORTED_LOOKUPS, UNSUPPORTED_LOOKUPS, type LookupKind, type SearchAdapter } from '../read/search.ts';
import type { ReadSession } from '../read/session.ts';
import { ReadError } from '../read/states.ts';
import type { Batch } from '../results/batch.ts';
import { searchBatch } from '../results/search-batch.ts';
import { normalizeKey } from '../scope/keys.ts';

/** Capability each lookup needs from a selected index. */
const CAPABILITY: Record<string, string> = { word: 'word_exact', form: 'form_exact', lemma: 'lemma_exact', grammar: 'grammar_exact' };

export interface LanguageWorkload { mode: string; depth: string; language: string; lookup: string; key: string; sources: string[] | null }

/** The selected sources offering a capability, in a stable order. */
export async function sourcesWith(session: ReadSession, capability: string): Promise<string[]> {
  const sources: string[] = [];
  let after: [string, string] | null = null;
  for (;;) {
    const { rows, more }: { rows: Record<string, unknown>[]; more: boolean } = await session.query('release_sources', { after });
    for (const row of rows) if (row.capability === capability && Number(row.available) > 0) sources.push(String(row.source_revision_id));
    if (!more || !rows.length) break;
    after = [String(rows.at(-1)!.source_revision_id), String(rows.at(-1)!.capability)];
  }
  return [...new Set(sources)].sort(compareUtf8);
}

/** Exact word, form, lemma or grammar occurrences through the read search interface. Keys typed
 *  by the host are normalized with their script's rule; the batch states what was searched. */
export async function languageBatch(session: ReadSession, workload: LanguageWorkload, continuation: string | null,
                                    guidanceVersion: string, adapter: SearchAdapter = new PagedIndexSearch()): Promise<Batch> {
  const lookup = workload.lookup;
  if (![...SUPPORTED_LOOKUPS, ...UNSUPPORTED_LOOKUPS].includes(lookup as LookupKind))
    throw new ReadError('invalid_request', `Unknown lookup "${lookup}"; use word, form, lemma or grammar`);
  if (typeof workload.key !== 'string' || !workload.key.trim()) throw new ReadError('invalid_request', 'A search lead needs a key');
  let sources = workload.sources;
  if (sources != null && (!Array.isArray(sources) || !sources.length || !sources.every(s => isIdentifier(s))))
    throw new ReadError('invalid_request', 'Sources are source revision IDs as listed by the study tool');
  if (sources == null) {
    sources = UNSUPPORTED_LOOKUPS.includes(lookup as LookupKind) ? ['none'] : await sourcesWith(session, CAPABILITY[lookup]);
    if (!sources.length) throw new ReadError('missing_index', `No selected source offers ${lookup} search`);
  }
  return searchBatch(session, adapter, { mode: workload.mode, depth: workload.depth, language: workload.language, lookup,
    key: normalizeKey(lookup, workload.key), sources }, continuation, guidanceVersion);
}
