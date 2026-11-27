import {canonicalJson} from '../../services/maintenance/control/src/d1.ts';

/** In-memory stand-in for the GitHub REST endpoints Control uses. Synthetic only. */
export interface FakeRun {
  id: number;
  path: string;
  event: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  job: string;
  display_title: string;
}

interface DispatchBody {
  ref: string;
  inputs: {job: string; dispatch_ref: string};
}

interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, value?: unknown) =>
  new Response(value === undefined ? null : JSON.stringify(value), {status});
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The behaviour switches a test can turn on. */
function newState() {
  return {
    loseNextDispatchResponse: false,
    failDispatch: false,
    redirect: false,
    down: false,
    offline: false,
    failCancel: false,
    onDispatch: undefined as
      undefined | ((run: FakeRun) => void | Promise<void>),
    onRecipeRead: undefined as undefined | (() => void | Promise<void>),
    rawRecipes: new Map<string, Uint8Array>(),
  };
}

class FakeGitHubServer {
  readonly commit: string;
  readonly runs = new Map<number, FakeRun>();
  readonly recipes: Map<string, unknown>;
  readonly requests: FakeRequest[] = [];
  readonly state = newState();
  private next = 1000;

  constructor(options: {commit?: string; recipes?: Record<string, unknown>}) {
    this.commit = options.commit ?? 'a'.repeat(40);
    this.recipes = new Map(Object.entries(options.recipes ?? {}));
  }

  fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({method, url, headers, body});
    const refused = this.refuse(init);
    if (refused) return refused;
    const path = url.replace('https://api.github.com/repos/owner/app', '');
    return (
      (await this.runRoutes(method, path, body)) ??
      (await this.recipeRoutes(method, path)) ??
      json(404, {})
    );
  };

  /** Like Cloudflare Workers: redirect 'error' is not implemented and throws before sending. */
  private refuse(init: RequestInit): Response | undefined {
    if (init.redirect === 'error')
      throw new TypeError(
        'Invalid redirect value, must be one of "follow" or "manual"',
      );
    if (init.redirect !== 'manual')
      throw new Error('redirects must not be followed');
    if (this.state.redirect)
      return new Response(null, {
        status: 302,
        headers: {location: 'https://evil.example.invalid/'},
      });
    if (this.state.offline) throw new TypeError('network unreachable');
    return this.state.down ? json(503, {}) : undefined;
  }

  private async runRoutes(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response | undefined> {
    if (
      method === 'POST' &&
      path === '/actions/workflows/prepare.yml/dispatches'
    )
      return this.dispatch(body as DispatchBody);
    let match = /^\/actions\/runs\/(\d+)$/.exec(path);
    if (method === 'GET' && match) {
      const run = this.runs.get(Number(match[1]));
      return run ? json(200, run) : json(404, {});
    }
    match = /^\/actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (method === 'POST' && match) return this.cancel(Number(match[1]));
    if (
      method === 'GET' &&
      path.startsWith('/actions/workflows/prepare.yml/runs?')
    )
      return this.listRuns(path);
    return undefined;
  }

  private async dispatch(body: DispatchBody) {
    if (this.state.failDispatch) return json(422, {});
    const id = this.next++;
    // GitHub records the run title from run-name, which prepare.yml builds from dispatch_ref.
    this.runs.set(id, {
      id,
      path: '.github/workflows/prepare.yml',
      event: 'workflow_dispatch',
      head_branch: body.ref,
      head_sha: this.commit,
      status: 'queued',
      conclusion: null,
      job: body.inputs.job,
      display_title: `Preparation ${body.inputs.dispatch_ref}`,
    });
    await this.state.onDispatch?.(this.runs.get(id)!);
    if (this.state.loseNextDispatchResponse) {
      this.state.loseNextDispatchResponse = false;
      throw new TypeError('connection reset');
    }
    return json(200, {
      workflow_run_id: id,
      run_url: `x/${id}`,
      html_url: `y/${id}`,
    });
  }

  private cancel(id: number) {
    const run = this.runs.get(id);
    if (!run || run.status === 'completed' || this.state.failCancel)
      return json(409, {});
    run.status = 'completed';
    run.conclusion = 'cancelled';
    return json(202, {});
  }

  private listRuns(path: string) {
    const query = new URL(`https://x${path}`).searchParams;
    const status = query.get('status');
    const perPage = Number(query.get('per_page') ?? 30);
    const page = Number(query.get('page') ?? 1);
    const matching = [...this.runs.values()]
      .reverse()
      .filter(
        run => !status || run.status === status || run.conclusion === status,
      );
    return json(200, {
      total_count: matching.length,
      workflow_runs: matching.slice((page - 1) * perPage, page * perPage),
    });
  }

  private async recipeRoutes(
    method: string,
    path: string,
  ): Promise<Response | undefined> {
    if (method !== 'GET') return undefined;
    if (path === '/contents/collection/recipes?ref=main')
      return json(
        200,
        [...this.recipes.keys()]
          .filter(key => key.startsWith('collection/recipes/'))
          .map(key => ({name: key.split('/').pop(), type: 'file'})),
      );
    const match =
      /^\/contents\/(collection\/(?:recipes|manifests)\/[^?]+)\?ref=main$/.exec(
        path,
      );
    if (!match) return undefined;
    await this.state.onRecipeRead?.();
    const raw = this.state.rawRecipes.get(match[1]);
    if (raw) return json(200, {encoding: 'base64', content: base64(raw)});
    const recipe = this.recipes.get(match[1]);
    if (recipe === undefined) return json(404, {});
    return json(200, {
      encoding: 'base64',
      content: base64(new TextEncoder().encode(canonicalJson(recipe))),
    });
  }
}

export function fakeGitHub(
  options: {commit?: string; recipes?: Record<string, unknown>} = {},
) {
  return new FakeGitHubServer(options);
}
