import { canonicalJson } from './d1.ts';
import type { JobInput } from './contracts.ts';
import type { WorkflowTransport } from './dispatch.ts';

/** The one fixed, reviewed preparation workflow on the application repository's main branch
 *  (Platform GitHub To-Be §2–3). Control passes only the job envelope; no branch, script or path. */
export const WORKFLOW_PATH = '.github/workflows/prepare.yml';
const WORKFLOW_FILE = 'prepare.yml';
const BRANCH = 'main';
const API = 'https://api.github.com';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export interface GitHubSettings { repository: string; token: string }
export interface RunInfo { run_id: string; head_sha: string; status: string; conclusion: string | null }

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
    const response = await this.fetcher(`${API}/repos/${this.settings.repository}${path}`, {
      method, redirect: 'error', headers: body === undefined ? this.headers : { ...this.headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new GitHubError(`GitHub ${method} refused with HTTP ${response.status}`, response.status);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /** Dispatch one unit. The job input is Control's canonical JSON text: the exact bytes it hashed. */
  async dispatch(input: JobInput): Promise<{ run_id: string }> {
    const reply = await this.call('POST', `/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      { ref: BRANCH, inputs: { job: canonicalJson(input) }, return_run_details: true }) as { workflow_run_id?: unknown } | null;
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
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null };
  }

  /** Runs of the preparation workflow that have not finished yet (newest 100). */
  async activeRunIds(): Promise<string[]> {
    const reply = await this.call('GET', `/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&branch=${BRANCH}&per_page=100`) as
      { workflow_runs?: Array<{ id?: unknown; status?: unknown }> };
    return (reply.workflow_runs ?? []).filter(run => typeof run.id === 'number' && ACTIVE.has(String(run.status)))
      .map(run => String(run.id));
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
      const bytes = Uint8Array.from(atob(reply.content.replace(/\s/g, '')), c => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}
