import { canonicalJson } from '../../services/maintenance/control/src/d1.ts';

/** In-memory stand-in for the GitHub REST endpoints Control uses. Synthetic only. */
export interface FakeRun { id: number; path: string; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null; job: string; display_title: string }

export function fakeGitHub(options: { commit?: string; recipes?: Record<string, unknown> } = {}) {
  const commit = options.commit ?? 'a'.repeat(40);
  const runs = new Map<number, FakeRun>();
  const recipes = new Map(Object.entries(options.recipes ?? {}));
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  let next = 1000;
  const state = { loseNextDispatchResponse: false, failDispatch: false, redirect: false, down: false, offline: false,
    failCancel: false, onDispatch: undefined as undefined | ((run: FakeRun) => void | Promise<void>),
    onRecipeRead: undefined as undefined | (() => void | Promise<void>), rawRecipes: new Map<string, Uint8Array>() };

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, headers, body });
    if (init.redirect !== 'error') throw new Error('redirects must be refused');
    if (state.redirect) throw new TypeError('redirect refused');
    if (state.offline) throw new TypeError('network unreachable');
    const json = (status: number, value?: unknown) =>
      new Response(value === undefined ? null : JSON.stringify(value), { status });
    if (state.down) return json(503, {});
    const path = url.replace('https://api.github.com/repos/owner/app', '');
    if (method === 'POST' && path === '/actions/workflows/prepare.yml/dispatches') {
      if (state.failDispatch) return json(422, {});
      const id = next++;
      // GitHub records the run title from run-name, which prepare.yml builds from dispatch_ref.
      runs.set(id, { id, path: '.github/workflows/prepare.yml', event: 'workflow_dispatch', head_branch: body.ref,
        head_sha: commit, status: 'queued', conclusion: null, job: body.inputs.job, display_title: `Preparation ${body.inputs.dispatch_ref}` });
      await state.onDispatch?.(runs.get(id)!);
      if (state.loseNextDispatchResponse) { state.loseNextDispatchResponse = false; throw new TypeError('connection reset'); }
      return json(200, { workflow_run_id: id, run_url: `x/${id}`, html_url: `y/${id}` });
    }
    let match = /^\/actions\/runs\/(\d+)$/.exec(path);
    if (method === 'GET' && match) {
      const run = runs.get(Number(match[1]));
      return run ? json(200, run) : json(404, {});
    }
    match = /^\/actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (method === 'POST' && match) {
      const run = runs.get(Number(match[1]));
      if (!run || run.status === 'completed' || state.failCancel) return json(409, {});
      run.status = 'completed'; run.conclusion = 'cancelled';
      return json(202, {});
    }
    if (method === 'GET' && path.startsWith('/actions/workflows/prepare.yml/runs?')) {
      const query = new URL(`https://x${path}`).searchParams;
      const status = query.get('status');
      const perPage = Number(query.get('per_page') ?? 30);
      const page = Number(query.get('page') ?? 1);
      const matching = [...runs.values()].reverse().filter(run => !status || run.status === status || run.conclusion === status);
      return json(200, { total_count: matching.length, workflow_runs: matching.slice((page - 1) * perPage, page * perPage) });
    }
    match = /^\/contents\/(collection\/recipes\/[^?]+)\?ref=main$/.exec(path);
    if (method === 'GET' && match) {
      await state.onRecipeRead?.();
      const raw = state.rawRecipes.get(match[1]);
      if (raw) return json(200, { encoding: 'base64', content: btoa(String.fromCharCode(...raw)) });
      const recipe = recipes.get(match[1]);
      if (recipe === undefined) return json(404, {});
      return json(200, { encoding: 'base64', content: btoa(String.fromCharCode(...new TextEncoder().encode(canonicalJson(recipe)))) });
    }
    return json(404, {});
  };
  return { fetcher, runs, recipes, requests, state, commit };
}
