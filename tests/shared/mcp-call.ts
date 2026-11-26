import {
  protocolHandler,
  LEGACY_VERSIONS,
} from '../../packages/shared/src/platform.ts';

/** One request on the baseline protocol, as a host sends it. */
export async function call(
  handler: ReturnType<typeof protocolHandler>,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
) {
  const response = await handler.fetch(
    new Request('https://server.example.invalid/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': LEGACY_VERSIONS[0],
      },
      body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
    }),
  );
  const text = await response.text();
  return response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(
        text
          .split('\n')
          .find(line => line.startsWith('data: '))!
          .slice(6),
      )
    : JSON.parse(text);
}

type Schema = {
  type?: string;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};

/** What a host receives on connect: the instructions and the tool list. */
export async function delivered(server: Parameters<typeof protocolHandler>[0]) {
  const handler = protocolHandler(server, false);
  const init = await call(handler, 'initialize', {
    protocolVersion: LEGACY_VERSIONS[0],
    capabilities: {},
    clientInfo: {name: 'host', version: '1'},
  });
  const {result} = await call(handler, 'tools/list');
  await handler.close();
  return {
    instructions: init.result.instructions as string,
    tools: result.tools as {
      name: string;
      description: string;
      inputSchema: Schema;
    }[],
  };
}

/** Every description inside a tool's input schema. */
export function fieldDescriptions(schema: Schema): string[] {
  const below = [
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
  ];
  return [
    ...(schema.description ? [schema.description] : []),
    ...below.flatMap(fieldDescriptions),
  ];
}
