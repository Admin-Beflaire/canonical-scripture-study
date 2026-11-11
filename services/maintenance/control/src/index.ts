import { protectedWorker, protocolHandler, type AccessSettings } from '../../../../packages/shared/src/platform.ts';
import type { D1Database } from './d1.ts';
import { GitHubActions } from './github.ts';
import { jobRoutes } from './jobs.ts';
import { controlServer } from './mcp.ts';
import type { ObjectStore } from './selection.ts';

type Bucket = { list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: Array<{ key: string; size: number }>; truncated: boolean; cursor?: string }> };
type ControlSettings = AccessSettings & { DATA_DB?: D1Database; PRIVATE_OBJECTS?: Bucket; GITHUB_REPOSITORY?: string; PREPARATION_DISPATCH_TOKEN?: string };

/** The private bucket, read only, for the scope check's artifact sizes. */
function objects(settings: ControlSettings): ObjectStore | null {
  const bucket = settings.PRIVATE_OBJECTS;
  if (!bucket) return null;
  return {
    async list(prefix, cursor) {
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      return { objects: page.objects.map(item => ({ key: item.key, size: item.size })), ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) };
    },
  };
}

/** Dispatch is optional: without the PREPARATION_DISPATCH_TOKEN secret (GITHUB_REPOSITORY is a plain
 *  configuration value), tasks are recorded but not dispatched. */
function github(settings: ControlSettings): GitHubActions | null {
  if (!settings.GITHUB_REPOSITORY || !settings.PREPARATION_DISPATCH_TOKEN) return null;
  try { return new GitHubActions({ repository: settings.GITHUB_REPOSITORY, token: settings.PREPARATION_DISPATCH_TOKEN }); }
  catch { return null; }
}

/** The single Maintenance MCP and the preparation runner's internal job routes.
 *  Platform authenticates both before either handler runs. */
export default protectedWorker('control', {
  host(request, settings, identity) {
    const config = settings as ControlSettings;
    if (!config.DATA_DB) return Promise.resolve(new Response('Unavailable', { status: 503 }));
    const db = config.DATA_DB;
    return protocolHandler(() => controlServer(db, identity.email, settings.ENHANCEMENTS, github(config), objects(config)), settings.ENHANCEMENTS).fetch(request);
  },
  job(request, settings) {
    const config = settings as ControlSettings;
    if (!config.DATA_DB) return Promise.resolve(new Response('Unavailable', { status: 503 }));
    return jobRoutes(config.DATA_DB, github(config), objects(config))(request);
  },
});
