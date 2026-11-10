import { protectedWorker, protocolHandler, type AccessSettings } from '../../../../packages/shared/src/platform.ts';
import type { D1Database } from './d1.ts';
import { GitHubActions } from './github.ts';
import { jobRoutes } from './jobs.ts';
import { controlServer } from './mcp.ts';

type ControlSettings = AccessSettings & { DATA_DB?: D1Database; GITHUB_REPOSITORY?: string; PREPARATION_DISPATCH_TOKEN?: string };

/** Dispatch is optional: without its two secrets, tasks are recorded but not dispatched. */
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
    return protocolHandler(() => controlServer(db, identity.email, settings.ENHANCEMENTS, github(config)), settings.ENHANCEMENTS).fetch(request);
  },
  job(request, settings) {
    const config = settings as ControlSettings;
    if (!config.DATA_DB) return Promise.resolve(new Response('Unavailable', { status: 503 }));
    return jobRoutes(config.DATA_DB, github(config))(request);
  },
});
