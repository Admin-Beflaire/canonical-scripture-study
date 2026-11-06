import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { smoke } from '../../infrastructure/github/deployment/smoke.mjs';
import { platformServer, protocolHandler } from '../../packages/shared/src/platform.ts';

for (const enhancements of [false,true]) {
  test(`deployed protocol smoke checks the pinned SDK with enhancements=${enhancements}`, async () => {
    const handler = protocolHandler(()=>platformServer('study',enhancements),enhancements);
    const fetcher = async (url: string, options: RequestInit) => {
      const headers = new Headers(options.headers);
      if (headers.get('Cookie') !== 'CF_Authorization=fixture-jwt') return new Response(null,{status:403});
      return handler.fetch(new Request(url,options));
    };
    await smoke('study.example.invalid','fixture-jwt',fetcher);
    await handler.close();
  });
}
test('smoke rejects open endpoints, login redirects after authentication and incompatible negotiation', async () => {
  await assert.rejects(smoke('study.example.invalid','fixture-jwt', async()=>new Response('{}')), /deny access/);
  await assert.rejects(smoke('study.example.invalid','fixture-jwt', async()=>new Response(null,{status:302})), /Authenticated/);
  await assert.rejects(smoke('study.example.invalid','fixture-jwt', async (_url: string, options: RequestInit)=> {
    if (new Headers(options.headers).get('Cookie') !== 'CF_Authorization=fixture-jwt') return new Response(null,{status:401});
    return Response.json({jsonrpc:'2.0',id:2,result:{protocolVersion:'wrong'}});
  }), /negotiation/);
});
test('public CLI failure never prints private endpoint or JWT markers', () => {
  const result = spawnSync(process.execPath,['infrastructure/github/deployment/smoke.mjs','private-marker.invalid;bad'], {encoding:'utf8',env:{...process.env,DEPLOYMENT_SMOKE_JWT:'private-marker-token'}});
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.equal(result.stderr.trim(),'Protected endpoint check failed');
});
