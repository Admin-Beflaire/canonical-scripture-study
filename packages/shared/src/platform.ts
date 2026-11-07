import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { createMcpHandler, legacyStatelessFallback, McpServer, type McpServerFactory } from '@modelcontextprotocol/server';

/** Only authentication settings, not a duplicate of generated resource bindings. */
export interface AccessSettings {
  ACCESS_ISSUER: string;
  HOSTNAME: string;
  HOST_AUDIENCE: string;
  DEPLOYMENT_CLIENT_ID: string;
  JOB_AUDIENCE?: string;
  ENHANCEMENTS: boolean;
}
export type ApplicationRole = 'study' | 'control';
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** Signature and required temporal claims; no caller-controlled key URL. */
export async function verifyAccess(token: string, issuer: string, audience: string, keys?: JWTVerifyGetKey) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience) throw new Error('Invalid Access configuration');
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return (await jwtVerify(token, jwks, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'iss', 'aud'], clockTolerance: 0 })).payload;
}

/** Platform transport only. Owning applications supply their domain tool factory. */
export function protocolHandler(factory: McpServerFactory, enhancements: boolean) {
  if (!enhancements) return { fetch: legacyStatelessFallback(factory, undefined, { maxRequestBodySize: 65536 }), close: async () => {} };
  return createMcpHandler(factory, { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: 65536 });
}

/** Empty authenticated servers until owning packages supply domain operations. */
export function platformServer(role: ApplicationRole, enhancements: boolean) {
  return new McpServer({ name: `canonical-scripture-${role}`, version: '0.1.0' }, {
    supportedProtocolVersions: enhancements ? ['2026-07-28', ...LEGACY_VERSIONS] : [...LEGACY_VERSIONS],
  });
}

/** Parse only a bounded deployment-check body without consuming the request
 *  passed to the MCP handler. A streaming request may omit Content-Length. */
async function boundedRpc(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error('Request body too large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    // Do not await cancellation of one tee branch: the original request may
    // still be needed by the downstream handler.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Authenticate before invoking either host or job handler. No raw identity trust. */
export function protectedWorker(role: ApplicationRole, options: {
  keys?: JWTVerifyGetKey;
  host?: (request: Request, settings: AccessSettings) => Promise<Response>;
  job?: (request: Request, settings: AccessSettings) => Promise<Response>;
} = {}) {
  // Cache only trusted issuer keys between requests, never request identity/state.
  let cachedIssuer = '';
  let cachedKeys: JWTVerifyGetKey | undefined;
  return {
    async fetch(request: Request, settings?: AccessSettings): Promise<Response> {
      if (!settings || !settings.HOSTNAME || !settings.HOST_AUDIENCE || !settings.ACCESS_ISSUER || !/^[a-f0-9]{32}\.access$/.test(settings.DEPLOYMENT_CLIENT_ID || '') || typeof settings.ENHANCEMENTS !== 'boolean') return new Response('Unavailable', { status: 503 });
      const url = new URL(request.url);
      if (url.protocol !== 'https:' || url.host !== settings.HOSTNAME || (request.headers.has('Host') && request.headers.get('Host') !== settings.HOSTNAME)) return new Response('Forbidden', { status: 403 });
      const origin = request.headers.get('Origin');
      if (origin !== null && origin !== url.origin) return new Response('Forbidden', { status: 403 });
      const hostRoute = url.pathname === '/mcp';
      const jobRoute = role === 'control' && /^\/internal\/jobs\/[^/]+(?:\/[^/]+)*$/.test(url.pathname);
      if (!hostRoute && !jobRoute) return new Response('Not found', { status: 404 });
      const audience = jobRoute ? settings.JOB_AUDIENCE : settings.HOST_AUDIENCE;
      if (!audience || (jobRoute && audience === settings.HOST_AUDIENCE)) return new Response('Unavailable', { status: 503 });
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16384) return new Response('Unauthorized', { status: 401 });
      try {
        if (!options.keys && cachedIssuer !== settings.ACCESS_ISSUER) {
          if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(settings.ACCESS_ISSUER)) throw new Error('Invalid issuer');
          cachedKeys = createRemoteJWKSet(new URL(`${settings.ACCESS_ISSUER}/cdn-cgi/access/certs`));
          cachedIssuer = settings.ACCESS_ISSUER;
        }
        const claims = await verifyAccess(token, settings.ACCESS_ISSUER, audience, options.keys ?? cachedKeys);
        const service = claims.common_name;
        if (jobRoute) {
          if (typeof service !== 'string' || !service.endsWith('.access') || service === settings.DEPLOYMENT_CLIENT_ID)
            return new Response('Forbidden', { status: 403 });
        } else if (service !== undefined) {
          if (service !== settings.DEPLOYMENT_CLIENT_ID || request.method !== 'POST')
            return new Response('Forbidden', { status: 403 });
          // Deny every non-discovery method before calling any application handler.
          if (Number(request.headers.get('content-length') || 0) > 65536)
            return new Response('Forbidden', { status: 403 });
          let rpc: unknown;
          try { rpc = await boundedRpc(request); }
          catch { return new Response('Forbidden', { status: 403 }); }
          if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)
              || (rpc as Record<string,unknown>).jsonrpc !== '2.0'
              || !['initialize', 'ping', 'tools/list'].includes(String((rpc as Record<string,unknown>).method)))
            return new Response('Forbidden', { status: 403 });
        } else if (typeof claims.email !== 'string' || !claims.email.includes('@')) {
          return new Response('Forbidden', { status: 403 });
        }
      }
      catch { return new Response('Unauthorized', { status: 401 }); }
      if (jobRoute) return options.job ? options.job(request, settings) : new Response('Not implemented', { status: 501 });
      if (options.host) return options.host(request, settings);
      const handler = protocolHandler(() => platformServer(role, settings.ENHANCEMENTS), settings.ENHANCEMENTS);
      return handler.fetch(request);
    },
  };
}
