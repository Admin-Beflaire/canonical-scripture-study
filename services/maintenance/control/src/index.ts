import { protectedWorker, protocolHandler, type AccessSettings } from '../../../../packages/shared/src/platform.ts';
import type { D1Database } from './d1.ts';
import { controlServer } from './mcp.ts';

/** The single Maintenance MCP. Platform authenticates first; jobs callbacks follow in MC-02. */
export default protectedWorker('control', {
  host(request, settings, identity) {
    const db = (settings as AccessSettings & { DATA_DB?: D1Database }).DATA_DB;
    if (!db) return Promise.resolve(new Response('Unavailable', { status: 503 }));
    return protocolHandler(() => controlServer(db, identity.email, settings.ENHANCEMENTS), settings.ENHANCEMENTS).fetch(request);
  },
});
