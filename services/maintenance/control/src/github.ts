import { canonicalJson, sha256 } from './d1.ts';
import type { JobInput } from './contracts.ts';
import type { WorkflowTransport } from './dispatch.ts';

/** The one fixed, reviewed preparation workflow on the application repository's main branch
 *  (Platform GitHub To-Be §2–3). Control passes only the job envelope; no branch, script or path. */
export const WORKFLOW_PATH = '.github/workflows/prepare.yml';
const WORKFLOW_FILE = 'prepare.yml';
const BRANCH = 'main';
const API = 'https://api.github.com';
const ACTIVE_STATUSES = ['requested', 'queued', 'pending', 'waiting', 'in_progress'] as const;
const MAX_PAGES = 10;

/** The run title GitHub records from the dispatch input (`run-name` in prepare.yml). It ties a
 *  run to the exact job bytes it received, so a run can be matched to its dispatch independently. */
export const runTitle = (inputBasis: string) => `Preparation ${inputBasis}`;

export interface GitHubSettings { repository: string; token: string }
export interface RunInfo { run_id: string; head_sha: string; status: string; conclusion: string | null; title: string }

/** A reviewed file exists but is not valid UTF-8: a recipe problem, not an outage. */
export class FileEncodingError extends Error {}

export class GitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

/** GitHub REST access for dispatch, run identity and cancellation. Credentials go only to
 *  api.github.com, never follow redirects, and never appear in errors. */
export class GitHubActions implements WorkflowTransport {
  private readonly headers: Record<string, string>;
  private readonly settings: GitHubSettings;
  private readonly fetcher: typeof fetch;
  constructor(settings: GitHubSettings, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.settings = settings;
    this.fetcher = fetcher;
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(settings.repository)) throw new Error('Invalid repository name');
    if (!settings.token || /\s/.test(settings.token)) throw new Error('Missing dispatch token');
    this.headers = {
      Authorization: `Bearer ${settings.token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'canonical-scripture-study-control',
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let text: string;
    let response: Response;
    try {
      response = await this.fetcher(`${API}/repos/${this.settings.repository}${path}`, {
        method, redirect: 'error', headers: body === undefined ? this.headers : { ...this.headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) text = await response.text();
    } catch {
      throw new GitHubError(`GitHub ${method} request did not complete`);
    }
    if (!response.ok) throw new GitHubError(`GitHub ${method} refused with HTTP ${response.status}`, response.status);
    try { return text! ? JSON.parse(text!) : null; } catch { throw new GitHubError('GitHub reply was not JSON'); }
  }

  /** Dispatch one unit. The job input is Control's canonical JSON text: the exact bytes it hashed. */
  async dispatch(input: JobInput): Promise<{ run_id: string }> {
    const job = canonicalJson(input);
    const reply = await this.call('POST', `/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref: BRANCH, inputs: { job, dispatch_ref: await sha256(job) }, return_run_details: true }) as { workflow_run_id?: unknown } | null;
    const id = reply?.workflow_run_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new GitHubError('Dispatch returned no run identity');
    return { run_id: String(id) };
  }

  /** A run of the fixed preparation workflow, dispatched on main; anything else is refused. */
  async run(runId: string): Promise<RunInfo> {
    if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new GitHubError('Invalid run identity');
    const run = await this.call('GET', `/actions/runs/${runId}`) as Record<string, unknown>;
    if (run.path !== WORKFLOW_PATH || run.event !== 'workflow_dispatch' || run.head_branch !== BRANCH
        || typeof run.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(run.head_sha) || typeof run.status !== 'string')
      throw new GitHubError('Run is not a main-branch dispatch of the preparation workflow');
    return { run_id: runId, head_sha: run.head_sha, status: run.status,
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      title: typeof run.display_title === 'string' ? run.display_title : '' };
  }

  /** Every unfinished run of the preparation workflow, with its title, listed per status and
   *  page by page. Returns null when the listing may be incomplete, so callers never treat a
   *  partial list as proof that a run does not exist. */
  async activeRuns(): Promise<Array<{ run_id: string; title: string }> | null> {
    const runs = new Map<string, string>();
    for (const status of ACTIVE_STATUSES) {
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) return null;
        const reply = await this.call('GET',
          `/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&branch=${BRANCH}&status=${status}&per_page=100&page=${page}`) as
          { workflow_runs?: Array<{ id?: unknown; display_title?: unknown }> } | null;
        const items = reply?.workflow_runs;
        if (!Array.isArray(items)) return null;
        for (const run of items)
          if (typeof run.id === 'number') runs.set(String(run.id), typeof run.display_title === 'string' ? run.display_title : '');
        if (items.length < 100) break;
      }
    }
    return [...runs].map(([run_id, title]) => ({ run_id, title }));
  }

  /** Ask GitHub to cancel a run (best effort; a finished run cannot be cancelled). */
  async cancel(runId: string): Promise<boolean> {
    if (!/^[1-9][0-9]{0,19}$/.test(runId)) return false;
    try { await this.call('POST', `/actions/runs/${runId}/cancel`); return true; } catch { return false; }
  }

  /** A reviewed file from main, for example a recipe. */
  async readFile(path: string): Promise<string | null> {
    if (!/^collection\/recipes\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.json$/.test(path)) throw new GitHubError('Only recipes can be read');
    try {
      const reply = await this.call('GET', `/contents/${path}?ref=${BRANCH}`) as { encoding?: string; content?: string };
      if (reply.encoding !== 'base64' || typeof reply.content !== 'string') return null;
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(reply.content.replace(/\s/g, '')), c => c.charCodeAt(0)); }
      catch { throw new GitHubError('GitHub file content was not base64'); }
      try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
      catch { throw new FileEncodingError(`${path} is not valid UTF-8`); }
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}
