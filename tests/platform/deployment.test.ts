import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { smoke } from '../../infrastructure/github/deployment/smoke.mjs';
import { platformServer, protocolHandler } from '../../packages/shared/src/platform.ts';

const id = 'a'.repeat(32)+'.access';
const secret = 'fixture-only-not-a-real-credential';

for (const enhancements of [false,true]) {
  test(`deployed protocol smoke with service headers and enhancements=${enhancements}`, async () => {
    const handler = protocolHandler(()=>platformServer('study',enhancements),enhancements);
    const fetcher = async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      if (headers.has('Cookie') || headers.has('Cf-Access-Jwt-Assertion')) return new Response(null,{status:403});
      if (headers.get('CF-Access-Client-Id') !== id || headers.get('CF-Access-Client-Secret') !== secret) return new Response(null,{status:403});
      if (options.redirect !== 'manual') throw new Error('Credential redirect forbidden');
      const rpc = JSON.parse(String(options.body));
      if (rpc.method === 'tools/call') return new Response('denied',{status:403});
      return handler.fetch(new Request(url,options));
    };
    await smoke('study.example.invalid',id,secret,fetcher);
    await handler.close();
  });
}
test('smoke rejects open endpoint, authenticated redirects, permitted tool calls and bad negotiation', async () => {
  await assert.rejects(smoke('study.example.invalid',id,secret,async()=>new Response('{}')), /deny access/);
  await assert.rejects(smoke('study.example.invalid',id,secret,async()=>new Response(null,{status:302})), /Authenticated/);
  await assert.rejects(smoke('study.example.invalid',id,secret,async (_url:string, options:RequestInit)=>{
    if (!new Headers(options.headers).has('CF-Access-Client-Id')) return new Response(null,{status:401});
    return Response.json({jsonrpc:'2.0',id:2,result:{protocolVersion:'wrong'}});
  }), /negotiation/);
  await assert.rejects(smoke('study.example.invalid',id,secret,async (_url:string, options:RequestInit)=>{
    if (!new Headers(options.headers).has('CF-Access-Client-Id')) return new Response(null,{status:401});
    const rpc=JSON.parse(String(options.body));
    if (rpc.method==='initialize') return Response.json({jsonrpc:'2.0',id:rpc.id,result:{protocolVersion:rpc.params.protocolVersion}});
    if (rpc.method==='tools/call') return Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[]}});
    return Response.json({jsonrpc:'2.0',id:rpc.id,result:{}});
  }), /can call tools/);
  for(const value of ['', 'invalid', 'value\ninjected']) await assert.rejects(smoke('study.example.invalid',id,value));
});
test('public smoke CLI failure never prints private credentials',()=>{
  const result=spawnSync(process.execPath,['infrastructure/github/deployment/smoke.mjs','private-marker.invalid;bad'],{encoding:'utf8',env:{...process.env,DEPLOYMENT_ACCESS_CLIENT_ID:id,DEPLOYMENT_ACCESS_CLIENT_SECRET:'private-marker'}});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.equal(result.stderr.trim(),'Protected endpoint check failed');
});
