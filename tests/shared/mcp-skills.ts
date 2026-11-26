import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {protocolHandler} from '../../packages/shared/src/platform.ts';
import {responseBody} from './mcp-call.ts';

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
const MODERN = '2026-07-28';

type Handler = ReturnType<typeof protocolHandler>;

/** One request as a host sends it on the given protocol version. */
async function send(
  handler: Handler,
  version: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const modern = version === MODERN;
  const meta = {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': {name: 'host', version: '1'},
  };
  const response = await handler.fetch(
    new Request('https://server.example.invalid/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version,
        ...(modern ? {'Mcp-Method': method} : {}),
        ...(modern && typeof params.uri === 'string'
          ? {'Mcp-Name': params.uri}
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: modern ? {...params, _meta: meta} : params,
      }),
    }),
  );
  const body = await responseBody(response);
  assert.ok(body.result, `${method}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
}

/** What the server declares when a host connects on that version. */
export function skillSupport(handler: Handler, version: string) {
  return version === MODERN
    ? send(handler, version, 'server/discover')
    : send(handler, version, 'initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: {name: 'host', version: '1'},
      });
}

interface Listed {
  uri: string;
  frontmatter: {name: string; description: string};
  resources: {uri: string; digest: string; size: number}[];
}

/** Lists the skills, gets each and reads its file, checking size and digest as a host does. */
export async function readSkills(handler: Handler, version = '2025-11-25') {
  const listed = (await send(handler, version, 'skills/list'))
    .skills as Listed[];
  const read = [];
  for (const entry of listed) {
    const {skill} = await send(handler, version, 'skills/get', {
      uri: entry.uri,
    });
    assert.deepEqual(skill, entry);
    assert.equal(entry.uri, `skill://${entry.frontmatter.name}/SKILL.md`);
    assert.equal(entry.resources.length, 1);
    const [resource] = entry.resources;
    const {contents} = await send(handler, version, 'resources/read', {
      uri: resource.uri,
    });
    const bytes = Buffer.from(contents[0].text, 'utf8');
    assert.equal(bytes.length, resource.size, entry.uri);
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      resource.digest,
      entry.uri,
    );
    read.push({...entry.frontmatter, file: contents[0].text as string});
  }
  return read;
}
