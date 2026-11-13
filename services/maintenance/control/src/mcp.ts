import { fromJsonSchema } from '@modelcontextprotocol/server';
import { platformServer } from '../../../../packages/shared/src/platform.ts';
import type { D1Database } from './d1.ts';
import type { GitHubActions } from './github.ts';
import { advance, reconcile } from './progress.ts';
import type { ObjectStore } from './selection.ts';
import { controlTask, listTasks, requestTask, taskReport, TASK_KINDS, type ControlAction, type Outcome, type TaskRequest } from './tasks.ts';

/** Essential guidance sent to both hosts on initialize, so no separate skill is needed. */
export const CONTROL_INSTRUCTIONS = `Canonical Scripture Study — Maintenance Control. Use these tools only on the owner's explicit instruction.

Workflow:
1. request_task: send the owner's instruction in his own words plus the structured scope. Use a short request_key per instruction; repeating the same key with the same scope safely returns the same task. If the instruction changes, use a new key and pass the old unfinished task's ID in supersedes.
2. If the result is "needs_information", ask the owner exactly the listed questions. Never invent values, and never create an approval: admission and statement approvals are owner decision references he gives you.
3. get_task with task_id reports requested, completed and remaining scope, jobs, checks and whether data became current. Without task_id it lists open and recent tasks; pass the returned cursor for the next page.
4. control_task pauses, cancels or resumes; pass the revision you last read. A conflict means the task changed: read it again before deciding.

Preparation runs by itself in GitHub Actions: a task that names a reviewed recipe in constraints.recipe dispatches its units in order, each unit's result starts the next, and failed units are retried up to three times. The task's extent must be the recipe's native_extent exactly, and its capabilities only ones the recipe provides. Nothing needs an open chat. get_task also reconciles interrupted work. Pause stops new units and promotion; cancel also stops running ones; resume continues only unfinished units.

When every unit has passed Preparation's quality check, Control checks the scope itself (the outputs are exactly what was instructed, from the named sources, over the whole extent, with the capabilities available, admitted, stored and not excluded). If both pass, the result becomes current at once: the owner's instruction is the permission, no second go is needed. If a check fails, the task is blocked with the reasons and the current data is unchanged.

Kinds: prepare (includes acquisition and index rebuilds), correct, replace (constraints.replaces lists the source revisions it replaces), remove (inputs are the source revisions to remove; an owner decision of kind "exclusion" with that subject keeps it out of later releases and rollbacks, and the same decision kind on a later prepare task lifts it), package (source references only, never answers), incorporate_statement (needs the owner's named and versioned approval), rollback (selects the previous release if it still validates), validate_restore (checks restored releases and blocks restored open tasks; selects constraints.select_release only if the owner asked).
Report to the owner plainly and separately: received, prepared, quality-checked, scope-checked, partial or current. Work continues without an open chat; check back with get_task.`;

const id = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' };
const inputRef = { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: {
  kind: { enum: ['source_revision', 'artifact', 'acquisition'] }, id,
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, byte_count: { type: 'integer', minimum: 0 } } };
const decisionRef = { type: 'object', additionalProperties: false, required: ['kind', 'ref'], properties: {
  kind: { enum: ['admission', 'statement', 'exclusion', 'other'] }, ref: { type: 'string', minLength: 1, maxLength: 200 },
  subject: id, name: { type: 'string', maxLength: 200 }, version: { type: 'string', maxLength: 50 } } };

const requestSchema = fromJsonSchema<TaskRequest>({
  type: 'object', additionalProperties: false, required: ['request_key', 'instruction', 'kind'],
  properties: {
    request_key: { ...id, description: 'Short stable key for this instruction; reuse it only to repeat the same request.' },
    instruction: { type: 'string', minLength: 1, maxLength: 4000, description: "The owner's instruction in his own words." },
    kind: { enum: [...TASK_KINDS] },
    inputs: { type: 'array', maxItems: 64, items: inputRef, description: 'Admitted source revisions, registered artifacts or acquisition routes.' },
    operations: { type: 'array', maxItems: 32, items: id },
    extent: { type: 'object', maxProperties: 64, description: 'Finite native extent, for example {"books":["GEN"]}.' },
    capabilities: { type: 'array', maxItems: 32, items: id, description: 'Needed outputs, for example source_text or word_index.' },
    constraints: { type: 'object', maxProperties: 32 },
    decision_refs: { type: 'array', maxItems: 16, items: decisionRef, description: 'Owner decision references the owner supplied.' },
    supersedes: { ...id, description: 'ID of the unfinished task this changed instruction replaces.' },
  },
});
const getSchema = fromJsonSchema<{ task_id?: string; cursor?: string }>({
  type: 'object', additionalProperties: false,
  properties: { task_id: id, cursor: { type: 'string', maxLength: 20, pattern: '^[0-9a-z]+$' } },
});
const controlSchema = fromJsonSchema<{ task_id: string; expected_revision: number; action: ControlAction }>({
  type: 'object', additionalProperties: false, required: ['task_id', 'expected_revision', 'action'],
  properties: { task_id: id, expected_revision: { type: 'integer', minimum: 1 }, action: { enum: ['pause', 'cancel', 'resume'] } },
});

const reply = (summary: string, data: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data, null, 1)}` }],
  ...(isError ? { isError: true } : {}),
});

/** Progression and reconciliation reach GitHub. Their failure must never stop a task tool
 *  from reporting what is saved; work continues on the next check or result. */
export type ProgressFailure = { operation: 'reconcile' | 'advance'; code: 'd1_write_quota' | 'failed'; message: string };

/** Report the failure of this invocation, not a persisted task error or an assumed future retry. */
export function describeProgressFailure(operation: ProgressFailure['operation'], error: unknown): ProgressFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const quota = /exceeded D1's free tier daily row write limit|D1.*daily row write limit/i.test(detail);
  return { operation, code: quota ? 'd1_write_quota' : 'failed',
    message: quota ? 'Cloudflare D1 daily row write limit exceeded.' : 'Progression failed; inspect Worker logs.' };
}

async function progressSafely<T>(operation: ProgressFailure['operation'], taskId: string,
  work: () => Promise<T>): Promise<{ value: T | null; failure?: ProgressFailure }> {
  try { return { value: await work() }; }
  catch (error) {
    const failure = describeProgressFailure(operation, error);
    console.error('Control task progression failed', { task_id: taskId, operation, code: failure.code, error });
    return { value: null, failure };
  }
}

/** The single Maintenance MCP server for one authenticated request. */
export function controlServer(db: D1Database, requester: string | undefined, enhancements: boolean, github: GitHubActions | null = null,
  objects: ObjectStore | null = null) {
  const server = platformServer('control', enhancements, CONTROL_INSTRUCTIONS);
  const owner = () => {
    if (!requester) throw new Error('Task tools need the authenticated owner.');
    return requester;
  };
  server.registerTool('request_task', {
    description: "Start a Maintenance task from the owner's instruction, or return the existing task for a repeated request key. Returns the task ID and state, or the information still needed.",
    inputSchema: requestSchema,
  }, async request => {
    const result = await requestTask(db, owner(), request);
    if (result.status === 'needs_information') return reply('More information is needed from the owner before this task can start.', result);
    if (result.status === 'conflict') return reply(result.message, result, true);
    const attempt = await progressSafely('advance', result.task.id, () => advance(db, github, result.task.id, objects));
    const progress = attempt.value;
    const task = (await taskReport(db, owner(), result.task.id))!;
    const dispatched = progress?.dispatched ?? [];
    return reply(`Task ${task.id} is ${task.state} (revision ${task.revision})${result.status === 'existing' ? ', already recorded for this request key' : ''}${dispatched.length ? `; dispatched ${dispatched.join(', ')}` : ''}${progress === null ? '; the progression check did not complete, it continues on the next check' : progress.limitation === 'github_unavailable' ? '; dispatch postponed (GitHub unavailable), it continues on the next check' : ''}.`,
      { status: result.status, task_id: task.id, state: task.state, revision: task.revision, superseded: result.superseded,
        dispatched, limitations: task.limitations, ...(attempt.failure ? { progression: { status: 'failed', ...attempt.failure } } : {}) });
  });
  server.registerTool('get_task', {
    description: 'Without task_id: list open and recent tasks (newest first, bounded pages). With task_id: requested, completed and remaining scope, jobs, checks, selection and limitations.',
    inputSchema: getSchema,
  }, async ({ task_id, cursor }) => {
    if (task_id) {
      let notes: string[] = [];
      const failures: ProgressFailure[] = [];
      if (await taskReport(db, owner(), task_id)) {
        // Reconcile interrupted work and continue progression before reporting. A GitHub outage
        // only postpones this; the saved status is still reported.
        const reconciliation = await progressSafely('reconcile', task_id, () => reconcile(db, github, task_id));
        notes = reconciliation.value ?? [];
        if (reconciliation.failure) failures.push(reconciliation.failure);
        const attempt = await progressSafely('advance', task_id, () => advance(db, github, task_id, objects));
        const progress = attempt.value;
        if (attempt.failure) failures.push(attempt.failure);
        else if (progress.limitation === 'github_unavailable') notes.push('Dispatch postponed: GitHub was unavailable; it continues on the next check.');
      }
      const report = await taskReport(db, owner(), task_id);
      if (!report) return reply('No task with this ID.', { task_id }, true);
      return reply(`Task ${report.id} is ${report.state} (revision ${report.revision}); data ${report.data_current ? 'became current' : 'is not current from this task'}.`,
        notes.length || failures.length ? { ...report, ...(notes.length ? { reconciliation: notes } : {}),
          ...(failures.length ? { progression: { status: 'failed', failures } } : {}) } : report);
    }
    const page = await listTasks(db, owner(), cursor);
    return reply(page.tasks.length ? `${page.tasks.length} task(s)${page.cursor ? '; more available with the cursor' : ''}.` : 'No tasks yet.', page);
  });
  server.registerTool('control_task', {
    description: 'Pause, cancel or resume a task. Pass the revision you last read; saved checkpoints and outputs are kept.',
    inputSchema: controlSchema,
  }, async ({ task_id, expected_revision, action }) => {
    const result = await controlTask(db, owner(), task_id, expected_revision, action);
    if (result.status !== 'ok') return reply(result.message, { status: result.status, state: result.task?.state, revision: result.task?.revision }, true);
    const cancelled: string[] = [];
    const failed: string[] = [];
    const failures: ProgressFailure[] = [];
    if (action === 'cancel') {
      const runs = (JSON.parse(result.task.outcome_json) as Outcome).cancel_requested_runs ?? [];
      for (const run of runs) ((github && await github.cancel(run)) ? cancelled : failed).push(run);
    }
    if (action === 'resume') {
      const reconciliation = await progressSafely('reconcile', task_id, () => reconcile(db, github, task_id));
      const progression = await progressSafely('advance', task_id, () => advance(db, github, task_id, objects));
      failures.push(...[reconciliation.failure, progression.failure].filter((failure): failure is ProgressFailure => !!failure));
    }
    const task = (await taskReport(db, owner(), task_id))!;
    const note = failed.length ? ` Cancellation of ${failed.length} run(s) did not go through; get_task requests it again.` : '';
    return reply(`Task ${task.id} is now ${task.state} (revision ${task.revision}).${note}`,
      { status: 'ok', state: task.state, revision: task.revision, ...(action === 'cancel' ? { runs_cancelled: cancelled, cancel_failed: failed } : {}),
        ...(failures.length ? { progression: { status: 'failed', failures } } : {}) });
  });
  return server;
}
