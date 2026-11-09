import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { protectedWorker, platformServer, protocolHandler, prepareProtocolValidators, LEGACY_VERSIONS, type AccessSettings } from '../../packages/shared/src/platform.ts';

const issuer = 'https://test-team.cloudflareaccess.com';
const pair = await generateKeyPair('RS256');
const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' }] });
const settings: AccessSettings = { ACCESS_ISSUER: issuer, HOSTNAME: 'control.example.invalid', HOST_AUDIENCE: 'human-control', JOB_AUDIENCE: 'runner', DEPLOYMENT_CLIENT_ID: 'a'.repeat(32)+'.access', ENHANCEMENTS: false };
const sign = (aud: string, iss = issuer, exp = Math.floor(Date.now()/1000)+300) => new SignJWT({email:'owner@example.invalid'}).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime(exp).sign(pair.privateKey);
function request(path = '/mcp', token?: string, hostname = settings.HOSTNAME, extra: Record<string,string> = {}) {
  return new Request(`https://${hostname}${path}`, { method: 'POST', headers: { ...(token ? {'Cf-Access-Jwt-Assertion': token} : {}), ...extra } });
}

test('signed JWTs isolate host and job routes before handlers run', async () => {
  const worker = protectedWorker('control', { keys, host: async () => new Response('host'), job: async () => new Response('job') });
  const human = await sign('human-control'), runner = await new SignJWT({common_name:'b'.repeat(32)+'.access'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('runner').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  assert.equal(await (await worker.fetch(request('/mcp', human), settings)).text(), 'host');
  assert.equal(await (await worker.fetch(request('/internal/jobs/result', runner), settings)).text(), 'job');
  for (const [path, token] of [['/mcp', runner], ['/internal/jobs/result', human], ['/mcp', await sign('study')], ['/mcp', await sign('human-control','https://evil.invalid')], ['/mcp', await sign('human-control',issuer,1)], ['/mcp','forged.jwt.assertion']] as const) {
    assert.equal((await worker.fetch(request(path, token), settings)).status, 401);
  }
  const noExpiry = await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('human-control').setIssuedAt().sign(pair.privateKey);
  const otherPair = await generateKeyPair('RS256');
  const forged = await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('human-control').setIssuedAt().setExpirationTime('5m').sign(otherPair.privateKey);
  for (const token of [noExpiry,forged]) assert.equal((await worker.fetch(request('/mcp',token),settings)).status,401);
  assert.equal((await worker.fetch(request(), settings)).status, 401);
  assert.equal((await worker.fetch(request('/mcp', human, 'preview.test.workers.dev'), settings)).status, 403);
  assert.equal((await worker.fetch(request('/mcp', human, settings.HOSTNAME, { Origin: 'https://evil.invalid' }), settings)).status, 403);
  assert.equal((await worker.fetch(request('/mcp', human, settings.HOSTNAME, { Host: 'evil.invalid' }), settings)).status, 403);
  assert.equal((await worker.fetch(request('/other', human), settings)).status, 404);
  assert.equal((await worker.fetch(request('/internal/jobs/result', runner), {...settings,JOB_AUDIENCE: settings.HOST_AUDIENCE})).status, 503);
  const study = protectedWorker('study', { keys });
  assert.equal((await study.fetch(request('/internal/jobs/result',runner),settings)).status,404);
  assert.equal((await worker.fetch(request('/mcp',human))).status,503);
  const deployment = await new SignJWT({common_name:settings.DEPLOYMENT_CLIENT_ID}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('human-control').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const foreign = await new SignJWT({common_name:'b'.repeat(32)+'.access'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience('human-control').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const host = protectedWorker('control',{keys,host:async()=>new Response('accepted')});
  const rpcRequest = (method:string, token=deployment) => new Request('https://control.example.invalid/mcp',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':token},body:JSON.stringify({jsonrpc:'2.0',id:1,method})});
  for (const method of ['initialize','ping','tools/list'])
    assert.equal((await host.fetch(rpcRequest(method),settings)).status,200);
  for (const method of ['tools/call','resources/read','tasks/cancel','notifications/initialized'])
    assert.equal((await host.fetch(rpcRequest(method),settings)).status,403);
  assert.equal((await host.fetch(rpcRequest('ping',foreign),settings)).status,403);
  assert.equal((await host.fetch(request('/mcp',deployment),settings)).status,403);
  assert.equal((await host.fetch(request('/internal/jobs/result',deployment),settings)).status,401);
  const batch = new Request('https://control.example.invalid/mcp',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':deployment},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'ping'}])});
  assert.equal((await host.fetch(batch,settings)).status,403);
  // Node/Workers streaming requests need not declare Content-Length.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40000));
      controller.enqueue(new Uint8Array(40000));
    },
  });
  const oversized = new Request('https://control.example.invalid/mcp',{
    method:'POST',headers:{'Cf-Access-Jwt-Assertion':deployment},body:stream,
    duplex:'half'
  } as RequestInit & {duplex:'half'});
  assert.equal(oversized.headers.has('Content-Length'), false);
  assert.equal((await host.fetch(oversized,settings)).status,403);
  // Reject before dispatching any application operation.
  // The original tee branch remains untouched; cancellation is best-effort.

});

async function rpc(handler: ReturnType<typeof protocolHandler>, body: {method:string; params?:Record<string,unknown>; [key:string]:unknown}, version?: string) {
  if (version === '2026-07-28') body = {...body,params:{...body.params,_meta:{'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'}}}};
  const response = await handler.fetch(new Request('https://fixture.invalid/mcp', {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(version ? {'MCP-Protocol-Version':version}: {}),...(version === '2026-07-28' ? {'Mcp-Method':body.method,...(typeof body.params?.name === 'string' ? {'Mcp-Name':body.params.name} : {})} : {})},body:JSON.stringify(body)}));
  const text = await response.text();
  const json = response.headers.get('Content-Type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
  return { response, json };
}
function fixture(enhancements: boolean) {
  return protocolHandler(() => {
    const server = platformServer('study', enhancements);
    server.registerTool('fixture_page', {inputSchema:fromJsonSchema<{cursor?:string}>({type:'object',properties:{cursor:{type:'string'}},additionalProperties:false})}, async ({cursor}) => ({content:[{type:'text',text:JSON.stringify(cursor ? {items:['b'],cursor:null} : {items:['a'],cursor:'next'})}]}));
    return server;
  }, enhancements);
}
for (const version of LEGACY_VERSIONS) {
  test(`SDK ${version} initializes, discovers, calls and continues with enhancements off`, async () => {
    const handler = fixture(false);
    const initialized = await rpc(handler,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
    assert.equal(initialized.json.result.protocolVersion,version);
    const list = await rpc(handler,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},version);
    assert.equal(list.json.result.tools[0].name,'fixture_page');
    for (const [args,expected] of [[{}, {items:['a'],cursor:'next'}],[{cursor:'next'},{items:['b'],cursor:null}]] as const) {
      const result = await rpc(handler,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'fixture_page',arguments:args}},version);
      assert.deepEqual(JSON.parse(result.json.result.content[0].text),expected);
    }
    await handler.close();
  });
}
test('modern enhancement is separate from the enabled legacy fallback', async () => {
  const handler = fixture(true);
  const modern = await rpc(handler,{jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'}}}},'2026-07-28');
  assert.ok(modern.json.result, JSON.stringify(modern.json));
  const disabled = fixture(false);
  const denied = await rpc(disabled,{jsonrpc:'2.0',id:9,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'}}}},'2026-07-28');
  assert.ok(denied.json.error, JSON.stringify(denied.json));
  await disabled.close();
  const tools = await rpc(handler,{jsonrpc:'2.0',id:3,method:'tools/list',params:{}},'2026-07-28');
  assert.equal(tools.json.result.tools[0].name,'fixture_page');
  for (const [args,expected] of [[{}, {items:['a'],cursor:'next'}],[{cursor:'next'},{items:['b'],cursor:null}]] as const) {
    const called = await rpc(handler,{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'fixture_page',arguments:args}},'2026-07-28');
    assert.deepEqual(JSON.parse(called.json.result.content[0].text),expected);
  }
  const legacy = await rpc(handler,{jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
  assert.equal(legacy.json.result.protocolVersion,'2025-03-26');
  await handler.close();
});

test('protocol validators are prepared at module load without side effects', async () => {
  // Already run once on import; repeating it must be harmless and change no handler behaviour.
  prepareProtocolValidators();
  const handler = fixture(false);
  const { json } = await rpc(handler, {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:LEGACY_VERSIONS[0],capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
  assert.equal(json.result.protocolVersion, LEGACY_VERSIONS[0]);
  await handler.close();
});

test('the owning application receives only the verified identity', async () => {
  const seen: unknown[] = [];
  const worker = protectedWorker('control', { keys, host: async (_request, _settings, identity) => { seen.push(identity); return new Response('ok'); } });
  assert.equal((await worker.fetch(request('/mcp', await sign('human-control')), settings)).status, 200);
  const deployment = await new SignJWT({ common_name: settings.DEPLOYMENT_CLIENT_ID, email: 'spoof@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(issuer).setAudience('human-control').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const rpc = new Request('https://control.example.invalid/mcp', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': deployment }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await worker.fetch(rpc, settings)).status, 200);
  assert.deepEqual(seen, [{ email: 'owner@example.invalid' }, { service: settings.DEPLOYMENT_CLIENT_ID }]);
});
