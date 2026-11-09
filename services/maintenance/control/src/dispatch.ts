import { canonicalJson, sha256, type D1Database } from './d1.ts';
import { assertJobInput, contractErrors, CONTRACT_VERSION, type ArtifactRef, type JobInput, type JobResult } from './contracts.ts';
import type { Scope, TaskRow } from './tasks.ts';

/** Dispatch intent and receipt matching (Maintenance Control To-Be §3). The transport
 *  is one fixed, reviewed workflow; it receives only the job envelope. */
export interface WorkflowTransport {
  dispatch(input: JobInput): Promise<{ run_id: string }>;
}

/** One unit of work, sized by Data Preparation. */
export interface UnitPlan {
  unit_id: string; kind: JobInput['kind']; manifest_revision: string; recipe_revision: string;
  native_extent: Record<string, unknown>; required_capabilities?: string[]; dependency_refs?: ArtifactRef[];
  checkpoint_ref?: ArtifactRef | null;
}
interface JobRow {
  task_id: string; task_revision: number; unit_id: string; attempt: number; kind: string; input_basis: string;
  run_id: string | null; state: string; checkpoint_ref: string | null; result_ref: string | null;
}
export type DispatchResult =
  | { status: 'dispatched'; run_id: string; attempt: number }
  | { status: 'existing'; run_id: string | null; attempt: number; state: string }
  | { status: 'uncertain'; attempt: number; message: string }
  | { status: 'not_dispatchable'; message: string };

const DISPATCHABLE = new Set(['queued', 'running']);
const ACTIVE_JOB = new Set(['intended', 'dispatched', 'running', 'checkpointed']);

export function jobInput(task: TaskRow, unit: UnitPlan, attempt: number): JobInput {
  const scope = JSON.parse(task.scope_json) as Scope;
  const input: JobInput = {
    contract_version: CONTRACT_VERSION, task_id: task.id, task_revision: task.revision, unit_id: unit.unit_id, attempt,
    kind: unit.kind, basis_digest: task.basis_digest, input_refs: scope.inputs, manifest_revision: unit.manifest_revision,
    recipe_revision: unit.recipe_revision, native_extent: unit.native_extent,
    required_capabilities: unit.required_capabilities ?? scope.capabilities, dependency_refs: unit.dependency_refs ?? [],
    checkpoint_ref: unit.checkpoint_ref ?? null, constraints: scope.constraints,
  };
  assertJobInput(input);
  return input;
}

/** Save the intent first, then call the workflow. An unanswered call leaves the intent
 *  for reconciliation; it is never silently re-sent as a second attempt. */
export async function dispatchUnit(db: D1Database, transport: WorkflowTransport, taskId: string, expectedRevision: number, unit: UnitPlan): Promise<DispatchResult> {
  const task = await db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').bind(taskId).first<TaskRow>();
  if (!task || task.revision !== expectedRevision || !DISPATCHABLE.has(task.state))
    return { status: 'not_dispatchable', message: task ? `Task is ${task.state} at revision ${task.revision}.` : 'Unknown task.' };
  const jobs = await db.prepare('SELECT * FROM maintenance_jobs WHERE task_id = ? AND unit_id = ? ORDER BY attempt DESC')
    .bind(task.id, unit.unit_id).all<JobRow>();
  const latest = jobs.results[0];
  if (latest && (ACTIVE_JOB.has(latest.state) || latest.state === 'succeeded'))
    return { status: 'existing', run_id: latest.run_id, attempt: latest.attempt, state: latest.state };
  const attempt = (latest?.attempt ?? 0) + 1;
  const input = jobInput(task, unit, attempt);
  const inputBasis = await sha256(canonicalJson(input));
  const intent = await db.prepare(`INSERT INTO maintenance_jobs(task_id, task_revision, unit_id, attempt, kind, input_basis, state)
    SELECT ?, ?, ?, ?, ?, ?, 'intended' WHERE EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND revision = ?
      AND state IN ('queued','running')) ON CONFLICT DO NOTHING`)
    .bind(task.id, task.revision, unit.unit_id, attempt, unit.kind, inputBasis, task.id, task.revision).run();
  if (!intent.meta.changes) return { status: 'not_dispatchable', message: 'Task or unit changed before dispatch.' };
  let runId: string;
  try {
    runId = (await transport.dispatch(input)).run_id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(runId)) throw new Error('Invalid run identity');
  } catch {
    return { status: 'uncertain', attempt, message: 'The workflow did not confirm the dispatch. The saved intent is reconciled before any new attempt.' };
  }
  await db.batch([
    db.prepare(`UPDATE maintenance_jobs SET run_id = ?, state = 'dispatched' WHERE task_id = ? AND unit_id = ? AND attempt = ? AND state = 'intended'`)
      .bind(runId, task.id, unit.unit_id, attempt),
    db.prepare(`UPDATE maintenance_tasks SET state = 'running', revision = revision + 1 WHERE id = ? AND revision = ? AND state = 'queued'`)
      .bind(task.id, task.revision),
  ]);
  return { status: 'dispatched', run_id: runId, attempt };
}

export type ReceiptResult =
  | { status: 'accepted' | 'duplicate'; eligible: boolean; state: string }
  | { status: 'rejected'; reason: string };

/** Accept a checkpoint/result only when it matches the recorded dispatch exactly. Results for
 *  cancelled or superseded work are kept as diagnostics but are never eligible for promotion.
 *  A successful workflow run by itself is not evidence of any output. */
export async function acceptReceipt(db: D1Database, value: unknown, reportedCommit: string, workflowCommit: string): Promise<ReceiptResult> {
  const errors = contractErrors('job_result', value);
  if (errors.length) return { status: 'rejected', reason: `invalid envelope: ${errors[0]}` };
  const result = value as JobResult;
  if (!/^[0-9a-f]{40}$/.test(workflowCommit) || reportedCommit !== workflowCommit) return { status: 'rejected', reason: 'commit does not match the reviewed workflow commit' };
  const job = await db.prepare('SELECT * FROM maintenance_jobs WHERE task_id = ? AND unit_id = ? AND attempt = ?')
    .bind(result.task_id, result.unit_id, result.attempt).first<JobRow>();
  const task = await db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').bind(result.task_id).first<TaskRow>();
  if (!job || !task) return { status: 'rejected', reason: 'no matching dispatch' };
  if (job.task_revision !== result.task_revision || task.basis_digest !== result.basis_digest) return { status: 'rejected', reason: 'task revision or basis does not match' };
  if (job.run_id === null) return { status: 'rejected', reason: 'dispatch not yet confirmed; reconcile the run first' };
  if (job.run_id !== result.run_id) return { status: 'rejected', reason: 'run does not match the dispatch' };
  const resultRef = `sha256:${await sha256(canonicalJson(result))}`;
  const live = !['cancelled', 'superseded'].includes(task.state);
  if (job.result_ref === resultRef) return { status: 'duplicate', eligible: live && job.state === 'succeeded', state: job.state };
  if (['succeeded', 'failed', 'cancelled'].includes(job.state)) {
    return { status: 'rejected', reason: 'a different final result is already recorded' };
  }
  // A late result for cancelled or superseded work is recorded as cancelled, never as success.
  const state = live ? result.state : 'cancelled';
  const checkpoint = result.checkpoint_ref ? `${result.checkpoint_ref.artifact_id}@${result.checkpoint_ref.sha256}` : job.checkpoint_ref;
  const update = await db.prepare(`UPDATE maintenance_jobs SET state = ?, checkpoint_ref = ?, result_ref = ?
    WHERE task_id = ? AND unit_id = ? AND attempt = ? AND state = ?`)
    .bind(state, checkpoint, resultRef, job.task_id, job.unit_id, job.attempt, job.state).run();
  if (!update.meta.changes) return { status: 'rejected', reason: 'the job changed while recording; resend the receipt' };
  return { status: 'accepted', eligible: live && state === 'succeeded', state };
}
