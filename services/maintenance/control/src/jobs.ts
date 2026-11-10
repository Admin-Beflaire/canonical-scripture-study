import type { D1Database } from './d1.ts';
import { acceptReceipt } from './dispatch.ts';
import type { GitHubActions } from './github.ts';
import { advance } from './progress.ts';

/** Control's internal job routes for the preparation runner (tests/conformance/internal-jobs.v1.json).
 *  Platform has already verified the Access Service Auth identity for /internal/jobs/*.
 *  A runner can read its own dispatch and report its result; it cannot create or change tasks. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const RUN = /^[1-9][0-9]{0,19}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BODY = 262144;

interface JobRow { task_id: string; task_revision: number; unit_id: string; attempt: number; input_basis: string; run_id: string | null; state: string }
interface TaskRow { id: string; revision: number; state: string; basis_digest: string }

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (request.method !== 'POST' || Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function jobRoutes(db: D1Database, github: GitHubActions | null) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const input = await body(request);
    if (!input) return json(400, { error: 'invalid_request' });
    if (path === '/internal/jobs/state') return state(db, github, input);
    if (path === '/internal/jobs/result') return result(db, github, input);
    return json(404, { error: 'not_found' });
  };
}

async function state(db: D1Database, github: GitHubActions | null, input: Record<string, unknown>): Promise<Response> {
  const { task_id, unit_id, attempt, run_id, job_input_basis } = input;
  if (Object.keys(input).length !== 5 || typeof task_id !== 'string' || !ID.test(task_id) || typeof unit_id !== 'string' || !ID.test(unit_id)
      || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1
      || typeof run_id !== 'string' || !RUN.test(run_id) || typeof job_input_basis !== 'string' || !DIGEST.test(job_input_basis))
    return json(400, { error: 'invalid_request' });
  const read = () => db.prepare('SELECT * FROM maintenance_jobs WHERE task_id = ? AND unit_id = ? AND attempt = ?')
    .bind(task_id, unit_id, attempt).first<JobRow>();
  let job = await read();
  if (!job || job.input_basis !== job_input_basis) return json(404, { error: 'no_dispatch' });
  if (job.run_id === null) {
    // The dispatch response was lost. Bind only a verified, unfinished run of the fixed workflow
    // that holds the exact job bytes and is not already bound to another job.
    if (job.state !== 'intended' || !github) return json(404, { error: 'no_dispatch' });
    try {
      if ((await github.run(run_id)).status === 'completed') return json(404, { error: 'no_dispatch' });
    } catch { return json(404, { error: 'no_dispatch' }); }
    await db.batch([
      db.prepare(`UPDATE maintenance_jobs SET run_id = ?, state = 'dispatched'
        WHERE task_id = ? AND unit_id = ? AND attempt = ? AND state = 'intended' AND run_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM maintenance_jobs WHERE run_id = ?)
          AND (SELECT state FROM maintenance_tasks WHERE id = ?) IN ('queued','running')`)
        .bind(run_id, task_id, unit_id, attempt, run_id, task_id),
      db.prepare(`UPDATE maintenance_tasks SET state = 'running', revision = revision + 1
        WHERE id = ? AND revision = ? AND state = 'queued'
          AND EXISTS (SELECT 1 FROM maintenance_jobs WHERE task_id = ? AND unit_id = ? AND attempt = ? AND run_id = ?)`)
        .bind(task_id, job.task_revision, task_id, unit_id, attempt, run_id),
    ]);
    job = await read();
  }
  if (!job || job.run_id !== run_id) return json(404, { error: 'no_dispatch' });
  const task = await db.prepare('SELECT id, revision, state, basis_digest FROM maintenance_tasks WHERE id = ?').bind(task_id).first<TaskRow>();
  if (!task) return json(404, { error: 'no_dispatch' });
  return json(200, {
    task_id, task_revision: task.revision, task_state: task.state, task_basis_digest: task.basis_digest,
    unit_id, attempt, job_revision: job.task_revision, job_input_basis: job.input_basis, run_id: job.run_id, job_state: job.state,
  });
}

async function result(db: D1Database, github: GitHubActions | null, input: Record<string, unknown>): Promise<Response> {
  const { result: value, commit } = input;
  if (Object.keys(input).length !== 2 || typeof commit !== 'string' || !value || typeof value !== 'object')
    return json(400, { error: 'invalid_request' });
  const runId = (value as { run_id?: unknown }).run_id;
  if (!github || typeof runId !== 'string' || !RUN.test(runId)) return json(200, { status: 'rejected', reason: 'run is not verifiable' });
  // The reviewed workflow commit comes from GitHub's record of the run, not from the runner.
  let workflowCommit: string;
  try { workflowCommit = (await github.run(runId)).head_sha; }
  catch { return json(200, { status: 'rejected', reason: 'run is not verifiable' }); }
  const receipt = await acceptReceipt(db, value, commit, workflowCommit);
  if (receipt.status === 'accepted') {
    // Advance the task now, so work continues without an open chat.
    const taskId = (value as { task_id: string }).task_id;
    try { await advance(db, github, taskId); } catch { /* get_task or resume retries progression */ }
  }
  return json(200, receipt);
}
