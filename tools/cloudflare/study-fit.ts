import { fromJsonSchema } from '@modelcontextprotocol/server';
import { platformServer, protectedWorker, protocolHandler } from '../../packages/shared/src/platform.ts';
import type { AccessSettings } from '../../packages/shared/src/platform.ts';
import type { D1ReadDatabase, StudyReadEnvironment } from '../../services/study/src/read/bindings.ts';
import { ReadSession } from '../../services/study/src/read/session.ts';
import { PagedIndexSearch } from '../../services/study/src/read/search.ts';
import { ReadError } from '../../services/study/src/read/states.ts';
import { searchBatch } from '../../services/study/src/results/search-batch.ts';
import { FIT_KEY, FIT_RELEASE, FIT_SOURCE } from './study-fit-fixture.ts';

/** Temporary measurement entry (never part of the ordinary Study bundle). It runs Study's real
 *  read adapter and batch code against the staged synthetic release. Only the current-release
 *  read is redirected to the unselected fixture release; every other query, check and budget is
 *  the production code path. The real current release is not read or changed. */
export function fitDatabase(db: D1ReadDatabase): D1ReadDatabase {
  return {
    prepare(sql: string) {
      if (sql.includes('FROM release_selection s')) {
        const fixed = db.prepare(`SELECT r.id AS release_id, r.schema_versions_json FROM releases r WHERE r.id = ?`).bind(FIT_RELEASE);
        const statement = { bind: () => statement, all: <T>() => fixed.all<T>() };
        return statement;
      }
      return db.prepare(sql);
    },
  };
}

const adapter = new PagedIndexSearch();
const workload = { mode: 'word_study', depth: 'standard', language: 'en', lookup: 'word', key: FIT_KEY, sources: [FIT_SOURCE] };

/** One bounded batch of the fixed fit search; returns what the batch delivered and the work it took. */
export async function runStudyFit(env: StudyReadEnvironment, continuation: string | null) {
  try {
    const session = await ReadSession.open({ ...env, DATA_DB: fitDatabase(env.DATA_DB) });
    const batch = await searchBatch(session, adapter, workload, continuation, 'fit/2');
    return {
      release_id: batch.release_id, hits: batch.evidence.length,
      occurrences: batch.evidence.map(item => item.kind === 'search_hit' ? item.hit.occurrence_id : ''),
      limitations: batch.limitations, continuation: batch.continuation, usage: session.budget.usage(), limits: session.budget.limits,
      response_bytes: new TextEncoder().encode(JSON.stringify(batch)).length,
    };
  } catch (error) {
    if (error instanceof ReadError) return { error: error.state, detail: error.message };
    throw error;
  }
}

const worker = protectedWorker('study', {
  host(request, settings) {
    const env = settings as AccessSettings & StudyReadEnvironment;
    return protocolHandler(() => {
      const server = platformServer('study', settings.ENHANCEMENTS);
      server.registerTool('fixture_search', {
        description: 'Temporary measurement: one bounded batch of the synthetic fit search. Pass the previous continuation to continue.',
        inputSchema: fromJsonSchema({ type: 'object', properties: { continuation: { type: 'string', maxLength: 2048 } }, additionalProperties: false }),
      }, async (args: unknown) => {
        const given = (args as { continuation?: unknown } | undefined)?.continuation;
        return { content: [{ type: 'text' as const, text: JSON.stringify(await runStudyFit(env, typeof given === 'string' ? given : null)) }] };
      });
      return server;
    }, settings.ENHANCEMENTS).fetch(request);
  },
});

export default worker;
