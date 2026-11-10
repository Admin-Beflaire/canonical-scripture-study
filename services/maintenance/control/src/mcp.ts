import { fromJsonSchema } from '@modelcontextprotocol/server';
import { platformServer } from '../../../../packages/shared/src/platform.ts';
import type { D1Database } from './d1.ts';
import type { GitHubActions } from './github.ts';
import { advance, reconcile } from './progress.ts';
import { controlTask, listTasks, requestTask, taskReport, TASK_KINDS, type ControlAction, type Outcome, type TaskRequest } from './tasks.ts';

/** Essential guidance sent to both hosts on initialize, so no separate skill is needed. */
export const CONTROL_INSTRUCTIONS = `Canonical Scripture Study — Maintenance Control. Use these tools only on the owner's explicit instruction.

Workflow:
1. request_task: send the owner's instruction in his own words plus the structured scope. Use a short request_key per instruction; repeating the same key with the same scope safely returns the same task. If the instruction changes, use a new key and pass the old unfinished task's ID in supersedes.
2. If the result is "needs_information", ask the owner exactly the listed questions. Never invent values, and never create an approval: admission and statement approvals are owner decision references he gives you.
3. get_task with task_id reports requested, completed and remaining scope, jobs, checks and whether data became current. Without task_id it lists open and recent tasks; pass the returned cursor for the next page.
4. control_task pauses, cancels or resumes; pass the revision you last read. A conflict means the task changed: read it again before deciding.

Preparation runs by itself in GitHub Actions: a task that names a reviewed recipe in constraints.recipe dispatches its units in order, each unit's result starts the next, and failed units are retried up to three times. Nothing needs an open chat. get_task also reconciles interrupted work. Pause stops new units; cancel also stops running ones; resume continues only unfinished units.

Kinds: prepare (includes acquisition and index rebuilds), correct, replace, remove, package (source references only, never answers), incorporate_statement (needs the owner's named and versioned approval), rollback, validate_restore.
Report to the owner plainly: received, prepared, checked, partial or current. Work continues without an open chat; check back with get_task.`;

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

/** The single Maintenance MCP server for one authenticated request. */
export function controlServer(db: D1Database, requester: string | undefined, enhancements: boolean, github: GitHubActions | null = null) {
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
    const progress = await advance(db, github, result.task.id);
    const task = (await taskReport(db, owner(), result.task.id))!;
    return reply(`Task ${task.id} is ${task.state} (revision ${task.revision})${result.status === 'existing' ? ', already recorded for this request key' : ''}${progress.dispatched.length ? `; dispatched ${progress.dispatched.join(', ')}` : ''}.`,
      { status: result.status, task_id: task.id, state: task.state, revision: task.revision, superseded: result.superseded,
        dispatched: progress.dispatched, limitations: task.limitations });
  });
  server.registerTool('get_task', {
    description: 'Without task_id: list open and recent tasks (newest first, bounded pages). With task_id: requested, completed and remaining scope, jobs, checks, selection and limitations.',
    inputSchema: getSchema,
  }, async ({ task_id, cursor }) => {
    if (task_id) {
      if (await taskReport(db, owner(), task_id)) {
        // Reconcile interrupted work and continue progression before reporting.
        await reconcile(db, github, task_id);
        await advance(db, github, task_id);
      }
      const report = await taskReport(db, owner(), task_id);
      if (!report) return reply('No task with this ID.', { task_id }, true);
      return reply(`Task ${report.id} is ${report.state} (revision ${report.revision}); data ${report.data_current ? 'became current' : 'is not current from this task'}.`, report);
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
    let cancelled: string[] = [];
    if (action === 'cancel' && github) {
      const runs = (JSON.parse(result.task.outcome_json) as Outcome).cancel_requested_runs ?? [];
      cancelled = (await Promise.all(runs.map(async run => (await github.cancel(run)) ? run : null))).filter((run): run is string => run !== null);
    }
    if (action === 'resume') {
      await reconcile(db, github, task_id);
      await advance(db, github, task_id);
    }
    const task = (await taskReport(db, owner(), task_id))!;
    return reply(`Task ${task.id} is now ${task.state} (revision ${task.revision}).`,
      { status: 'ok', state: task.state, revision: task.revision, ...(action === 'cancel' ? { runs_cancelled: cancelled } : {}) });
  });
  return server;
}
