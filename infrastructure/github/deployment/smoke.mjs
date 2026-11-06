import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** @param {string} hostname @param {string | undefined} jwt @param {(url: string, options: RequestInit) => Promise<Response>} fetcher */
export async function smoke(hostname, jwt, fetcher = fetch) {
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(hostname) || !jwt || /[\r\n;]/.test(jwt)) throw new Error('Invalid smoke inputs');
  const url = `https://${hostname}/mcp`;
  /** @param {Record<string, unknown>} body @param {string | undefined} token @param {string | undefined} [version] */
  async function post(body, token, version) {
    const response = await fetcher(url, {method:'POST', redirect:'manual', signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',
        ...(version ? {'MCP-Protocol-Version':version}:{}),
        ...(token ? {Cookie:`CF_Authorization=${token}`,'Cf-Access-Jwt-Assertion':token}:{})},
      body:JSON.stringify(body)});
    return response;
  }
  const ping = {jsonrpc:'2.0',id:1,method:'ping'};
  for (const token of [undefined,'invalid.assertion.token']) {
    const denied = await post(ping,token);
    if (![302,303,401,403].includes(denied.status)) throw new Error('Unauthenticated endpoint did not deny access');
    await denied.body?.cancel();
  }
  /** @param {Record<string, unknown>} body @param {string | undefined} [version] */
  async function rpc(body, version) {
    const response = await post(body,jwt,version);
    if (response.status !== 200) throw new Error('Authenticated endpoint failed');
    const text = await response.text();
    const json = response.headers.get('Content-Type')?.includes('text/event-stream')
      ? JSON.parse(text.split('\n').find(line=>line.startsWith('data: '))?.slice(6) ?? 'null') : JSON.parse(text);
    if (!json || json.id !== body.id || json.error || !json.result) throw new Error('Protocol response failed');
    return json.result;
  }
  for (const version of versions) {
    const initialized = await rpc({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'deployment-check',version:'1'}}});
    if (initialized.protocolVersion !== version) throw new Error('Baseline negotiation failed');
    await rpc(ping,version);
    if (initialized.capabilities?.tools) {
      const listed = await rpc({jsonrpc:'2.0',id:3,method:'tools/list',params:{}},version);
      if (!Array.isArray(listed.tools)) throw new Error('Tool discovery failed');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await smoke(process.argv[2] ?? '',process.env.DEPLOYMENT_SMOKE_JWT);
    console.log('Protected HTTP protocol checks passed; actual host observations remain separate');
  } catch {
    console.error('Protected endpoint check failed');
    process.exitCode = 1;
  }
}
