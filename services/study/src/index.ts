import { protectedWorker, protocolHandler, type AccessSettings } from '../../../packages/shared/src/platform.ts';
import type { StudyReadEnvironment } from './read/bindings.ts';
import { studyServer } from './mcp.ts';

/** The Study Worker: Platform authenticates every request; Study serves read-only tools. */
export default protectedWorker('study', {
  host(request, settings) {
    const env = settings as AccessSettings & Partial<StudyReadEnvironment>;
    if (!env.DATA_DB || !env.PRIVATE_OBJECTS) return Promise.resolve(new Response('Unavailable', { status: 503 }));
    const read = env as AccessSettings & StudyReadEnvironment;
    return protocolHandler(() => studyServer(read, settings.ENHANCEMENTS), settings.ENHANCEMENTS).fetch(request);
  },
});
