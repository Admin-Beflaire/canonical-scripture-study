import { fromJsonSchema } from '@modelcontextprotocol/server';
import { platformServer, protectedWorker, protocolHandler } from '../../packages/shared/src/platform.ts';
import type { AccessSettings } from '../../packages/shared/src/platform.ts';
import manifest from '../../tests/conformance/indexes/source.manifest.json' with { type: 'json' };

interface Artifact {
  registered_locator: string;
  byte_count: number;
  sha256: string;
}

interface FixtureBindings {
  DATA_DB: {
    prepare(sql: string): {
      bind(...values: string[]): {
        all<T>(): Promise<{ results: T[]; meta: { rows_read?: number } }>;
      };
    };
  };
  PRIVATE_OBJECTS: {
    get(key: string, options?: { range: { offset: number; length: number } }):
      Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

async function checkedRead(bucket: FixtureBindings['PRIVATE_OBJECTS'], key: string,
                           size: number, digest: string, offset?: number) {
  const object = await bucket.get(key, offset === undefined ? undefined : { range: { offset, length: size } });
  if (!object) throw new Error('Fixture object missing');
  const raw = await object.arrayBuffer();
  if (raw.byteLength !== size) throw new Error('Fixture object length mismatch');
  const hash = await crypto.subtle.digest('SHA-256', raw);
  const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== digest) throw new Error('Fixture object digest mismatch');
  return decoder.decode(raw);
}

/** Fixed IX-01 workload. The release and artifacts must be selected and registered in D1. */
export async function runStudyFit({ DATA_DB, PRIVATE_OBJECTS }: FixtureBindings) {
  const registered = await DATA_DB.prepare(`
    SELECT a.id, a.registered_locator, a.byte_count, a.sha256
    FROM release_selection s
    JOIN release_outputs m ON m.release_id = s.current_release_id
    JOIN artifacts a ON a.output_id = m.output_id
    WHERE s.current_release_id = ? AND a.id IN (?, ?)
  `).bind('ix-release', 'ix-source-manifest', 'ix-source-postings').all<Artifact & { id: string }>();
  const context = await DATA_DB.prepare(`
    SELECT p.exact_text
    FROM release_selection s
    JOIN release_outputs m ON m.release_id = s.current_release_id
    JOIN native_spans n ON n.output_id = m.output_id
    JOIN text_payloads p ON p.content_id = n.content_id
    WHERE s.current_release_id = ? AND n.id = ?
  `).bind('ix-release', 'ix-passage').all<{ exact_text: string }>();
  const directory = registered.results.find(row => row.id === 'ix-source-manifest');
  const postings = registered.results.find(row => row.id === 'ix-source-postings');
  if (!directory || !postings || context.results.length !== 1 || directory.byte_count > 2048) {
    throw new Error('Selected fixture unavailable');
  }

  const rawDirectory = await checkedRead(PRIVATE_OBJECTS, directory.registered_locator, directory.byte_count, directory.sha256);
  if (JSON.stringify(JSON.parse(rawDirectory)) !== JSON.stringify(manifest)) {
    throw new Error('Unexpected fixture manifest');
  }
  const [file] = manifest.files;
  if (postings.byte_count !== file.byte_length || postings.sha256 !== file.sha256) {
    throw new Error('Unexpected fixture postings registration');
  }

  const key = 'א';
  const pages = file.pages.filter(page => page.first_key <= key && key <= page.last_key);
  const matches = [];
  for (const page of pages) {
    const raw = await checkedRead(PRIVATE_OBJECTS, postings.registered_locator, page.byte_length, page.sha256, page.byte_offset);
    if (!raw.endsWith('\n')) throw new Error('Unaligned fixture page');
    for (const line of raw.slice(0, -1).split('\n')) {
      const row = JSON.parse(line);
      if (row.search_key === key) matches.push(row);
    }
  }
  return {
    matches,
    context: context.results[0].exact_text,
    d1Calls: 2,
    d1RowsRead: [registered.meta.rows_read ?? null, context.meta.rows_read ?? null],
    r2Bytes: directory.byte_count + pages.reduce((bytes, page) => bytes + page.byte_length, 0),
    r2Calls: 1 + pages.length,
  };
}

// Separate build entry for the temporary fit run. The ordinary Study entry never imports this.
const worker = protectedWorker('study', {
  host(request, settings) {
    const bindings = settings as AccessSettings & FixtureBindings;
    return protocolHandler(() => {
      const server = platformServer('study', settings.ENHANCEMENTS);
      server.registerTool('fixture_search', {
        inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
      }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await runStudyFit(bindings)) }],
      }));
      return server;
    }, settings.ENHANCEMENTS).fetch(request);
  },
});

export default worker;
