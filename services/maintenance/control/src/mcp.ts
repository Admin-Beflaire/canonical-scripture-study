import {fromJsonSchema} from '@modelcontextprotocol/server';
import {reportError} from '../../../../packages/shared/src/error-record.ts';
import {platformServer} from '../../../../packages/shared/src/platform.ts';
import type {D1Database} from './d1.ts';
import type {GitHubActions} from './github.ts';
import {formatBytes, tidyReleases} from './cleanup.ts';
import {advance, reconcile} from './progress.ts';
import type {ObjectStore} from './selection.ts';
import {
  controlTask,
  listTasks,
  requestTask,
  taskReport,
  STEPS,
  type ControlAction,
  type Outcome,
  type TaskRequest,
} from './tasks.ts';

/** Essential guidance sent to both hosts on initialize, so no separate skill is needed. */
export const CONTROL_INSTRUCTIONS = `Canonical Scripture Study — Maintenance Control. Use these tools only on the owner's explicit instruction.

Workflow:
1. request_task: send the owner's instruction in his own words plus the structured scope. Use a short request_key per instruction; repeating the same key with the same scope safely returns the same task. If the instruction changes, use a new key and pass the old unfinished task's ID in supersedes.
2. If the result is "needs_information", ask the owner exactly the listed questions. Never invent values, and never create an approval: admission and statement approvals are owner decision references he gives you.
3. get_task with task_id reports requested, completed and remaining scope, jobs, checks and whether data became current. Without task_id it lists open and recent tasks; pass the returned cursor for the next page.
4. control_task pauses, cancels or resumes; pass the revision you last read. A conflict means the task changed: read it again before deciding.
5. tidy_releases removes what no kept release and no open task needs (it also runs when a task ends). Each call does a bounded part: call it again while the result says more; skipped outputs are blocked by another output and are left.

Preparation runs by itself in GitHub Actions: a task lists the steps it needs, in order, and nothing is mandatory. A fetch step runs the units of the reviewed recipe in constraints.fetch_recipe and keeps the original; a build step runs the units of the recipe in constraints.recipe. Each unit's result starts the next, and failed units are retried up to three times. For a build, the task's extent must be the recipe's native_extent exactly, and its capabilities only ones the recipe provides. Nothing needs an open chat. get_task also reconciles interrupted work. Pause stops new units and promotion; cancel also stops running ones; resume continues only unfinished units.

When every unit of a build has passed Preparation's quality check, Control checks the scope itself (the outputs are exactly what was instructed, from the named sources, over the whole extent, with the capabilities available, admitted, stored and not excluded). A task that lists select then makes the result current at once: the owner's instruction is the permission, no second go is needed. If another build became current in between, Control builds the release again on the new current release, checks it again and retries a few times by itself. If a check fails, the task is blocked with the reasons and the current data is unchanged. A build without select ends checked and waits; a later task with steps ["select"] and constraints.candidate makes it current.

Steps that stand alone: remove (inputs are the source revisions to remove; an owner decision of kind "exclusion" with that subject keeps it out of later releases and rollbacks, and the same decision kind on a later build lifts it), rollback (selects the previous release if it still validates), validate_restore (checks restored releases and blocks restored open tasks; selects constraints.select_release only if the owner asked). constraints.replaces on a build lists the source revisions it replaces. An owner's statement approval (decision kind "statement", with name and version) belongs to the build of that statement. A package build holds source references only, never answers.
Starting a task (one request_key per instruction; the owner's go in chat is his admission decision, so give his exact words as the ref of each admission decision_refs entry, with the input's id as subject):
- Fetch only: steps ["fetch"], constraints {fetch_recipe}, extent the recipe's native_extent, capabilities [], inputs the acquisition and the source revision.
- Build and make current: steps ["build","select"], constraints {recipe}, extent and capabilities the recipe's, the same two inputs.
- Build only: steps ["build"]. Make that build current later: steps ["select"], constraints {candidate: the build task's ID}, no inputs.
- Remove: steps ["remove"], inputs the source revisions, decision kind "exclusion" per subject.
- One task has one extent, and each step's recipe has its own native_extent that it must equal. Chain two steps only when both recipes have the same extent; otherwise start one task per step.
- Input IDs are never guessed. The acquisition ID is the entry in the recipe's dependencies. The source revision is the one named by earlier tasks for the same source: read an earlier completed task with get_task and reuse its inputs. If an input is not registered, the task blocks at the first attempt and names it.

Report to the owner plainly and separately: received, prepared, quality-checked, scope-checked, partial or current. Work continues without an open chat; check back with get_task.`;

const id = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$',
};
const inputRef = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: {enum: ['source_revision', 'artifact', 'acquisition']},
    id,
    sha256: {type: 'string', pattern: '^[0-9a-f]{64}$'},
    byte_count: {type: 'integer', minimum: 0},
  },
};
const decisionRef = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'ref'],
  properties: {
    kind: {enum: ['admission', 'statement', 'exclusion', 'other']},
    ref: {type: 'string', minLength: 1, maxLength: 200},
    subject: id,
    name: {type: 'string', maxLength: 200},
    version: {type: 'string', maxLength: 50},
  },
};

const requestSchema = fromJsonSchema<TaskRequest>({
  type: 'object',
  additionalProperties: false,
  required: ['request_key', 'instruction', 'steps'],
  properties: {
    request_key: {
      ...id,
      description:
        'Short stable key for this instruction; reuse it only to repeat the same request.',
    },
    instruction: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: "The owner's instruction in his own words.",
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {enum: [...STEPS]},
      description:
        'The steps this task needs, in order, and nothing more: fetch (keeps an original; constraints.fetch_recipe names its recipe), build (builds checked outputs; constraints.recipe names its recipe), select (makes the build current; alone it makes a finished build current, constraints.candidate is that build\'s task ID). Examples: ["fetch"], ["build","select"], ["fetch","build","select"], ["select"]. remove, rollback and validate_restore each stand alone.',
    },
    inputs: {
      type: 'array',
      maxItems: 64,
      items: inputRef,
      description:
        'Admitted source revisions, registered artifacts or acquisition routes.',
    },
    operations: {type: 'array', maxItems: 32, items: id},
    extent: {
      type: 'object',
      maxProperties: 64,
      description: 'Finite native extent, for example {"books":["GEN"]}.',
    },
    capabilities: {
      type: 'array',
      maxItems: 32,
      items: id,
      description: 'Needed outputs, for example source_text or word_index.',
    },
    constraints: {type: 'object', maxProperties: 32},
    decision_refs: {
      type: 'array',
      maxItems: 16,
      items: decisionRef,
      description: 'Owner decision references the owner supplied.',
    },
    supersedes: {
      ...id,
      description:
        'ID of the unfinished task this changed instruction replaces.',
    },
  },
});
const getSchema = fromJsonSchema<{task_id?: string; cursor?: string}>({
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: id,
    cursor: {type: 'string', maxLength: 20, pattern: '^[0-9a-z]+$'},
  },
});
const tidySchema = fromJsonSchema<Record<string, never>>({
  type: 'object',
  additionalProperties: false,
  properties: {},
});
const controlSchema = fromJsonSchema<{
  task_id: string;
  expected_revision: number;
  action: ControlAction;
}>({
  type: 'object',
  additionalProperties: false,
  required: ['task_id', 'expected_revision', 'action'],
  properties: {
    task_id: id,
    expected_revision: {type: 'integer', minimum: 1},
    action: {enum: ['pause', 'cancel', 'resume']},
  },
});

const reply = (summary: string, data: unknown, isError = false) => ({
  content: [
    {
      type: 'text' as const,
      text: `${summary}\n\n${JSON.stringify(data, null, 1)}`,
    },
  ],
  ...(isError ? {isError: true} : {}),
});

/** Progression and reconciliation reach GitHub. Their failure must never stop a task tool
 *  from reporting what is saved; work continues on the next check or result. */
export type ProgressFailure = {
  operation: 'reconcile' | 'advance';
  code: 'd1_write_quota' | 'failed';
  message: string;
};

/** Report the failure of this invocation, not a persisted task error or an assumed future retry. */
export function describeProgressFailure(
  operation: ProgressFailure['operation'],
  error: unknown,
): ProgressFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const quota =
    /exceeded D1's free tier daily row write limit|D1.*daily row write limit/i.test(
      detail,
    );
  return {
    operation,
    code: quota ? 'd1_write_quota' : 'failed',
    message: quota
      ? 'Cloudflare D1 daily row write limit exceeded.'
      : 'Progression failed; inspect Worker logs.',
  };
}

async function progressSafely<T>(
  operation: ProgressFailure['operation'],
  taskId: string,
  work: () => Promise<T>,
): Promise<{value: T | null; failure?: ProgressFailure}> {
  try {
    return {value: await work()};
  } catch (error) {
    const failure = describeProgressFailure(operation, error);
    reportError(error, {
      tool: 'control',
      stage: operation,
      code: failure.code,
      ids: {task: taskId},
    });
    return {value: null, failure};
  }
}

/** What every task tool needs: the database, the authenticated owner and the executors. */
interface Tools {
  db: D1Database;
  owner: () => string;
  github: GitHubActions | null;
  objects: ObjectStore | null;
}

async function requestTaskTool(tools: Tools, request: TaskRequest) {
  const {db, github, objects} = tools;
  const result = await requestTask(db, tools.owner(), request);
  if (result.status === 'needs_information')
    return reply(
      'More information is needed from the owner before this task can start.',
      result,
    );
  if (result.status === 'conflict') return reply(result.message, result, true);
  if (request.supersedes) await tidyReleases(db, objects);
  const attempt = await progressSafely('advance', result.task.id, () =>
    advance(db, github, result.task.id, objects),
  );
  const progress = attempt.value;
  const task = (await taskReport(db, tools.owner(), result.task.id))!;
  const dispatched = progress?.dispatched ?? [];
  return reply(
    `Task ${task.id} is ${task.state} (revision ${task.revision})${result.status === 'existing' ? ', already recorded for this request key' : ''}${dispatched.length ? `; dispatched ${dispatched.join(', ')}` : ''}${progress === null ? '; the progression check did not complete, it continues on the next check' : progress.limitation === 'github_unavailable' ? '; dispatch postponed (GitHub unavailable), it continues on the next check' : ''}.`,
    {
      status: result.status,
      task_id: task.id,
      state: task.state,
      revision: task.revision,
      superseded: result.superseded,
      dispatched,
      limitations: task.limitations,
      ...(attempt.failure
        ? {progression: {status: 'failed', ...attempt.failure}}
        : {}),
    },
  );
}

/** Reconcile interrupted work and continue progression before reporting. A GitHub outage
 *  only postpones this; the saved status is still reported. */
async function refreshTask(tools: Tools, taskId: string) {
  const {db, github, objects} = tools;
  const failures: ProgressFailure[] = [];
  const reconciliation = await progressSafely('reconcile', taskId, () =>
    reconcile(db, github, taskId),
  );
  const notes = reconciliation.value ?? [];
  if (reconciliation.failure) failures.push(reconciliation.failure);
  const attempt = await progressSafely('advance', taskId, () =>
    advance(db, github, taskId, objects),
  );
  if (attempt.failure) failures.push(attempt.failure);
  else if (attempt.value?.limitation === 'github_unavailable')
    notes.push(
      'Dispatch postponed: GitHub was unavailable; it continues on the next check.',
    );
  return {notes, failures};
}

async function getTaskTool(
  tools: Tools,
  {task_id, cursor}: {task_id?: string; cursor?: string},
) {
  const {db} = tools;
  if (!task_id) {
    const page = await listTasks(db, tools.owner(), cursor);
    return reply(
      page.tasks.length
        ? `${page.tasks.length} task(s)${page.cursor ? '; more available with the cursor' : ''}.`
        : 'No tasks yet.',
      page,
    );
  }
  const {notes, failures} = (await taskReport(db, tools.owner(), task_id))
    ? await refreshTask(tools, task_id)
    : {notes: [], failures: []};
  const report = await taskReport(db, tools.owner(), task_id);
  if (!report) return reply('No task with this ID.', {task_id}, true);
  return reply(
    `Task ${report.id} is ${report.state} (revision ${report.revision}); data ${report.data_current ? 'became current' : 'is not current from this task'}.`,
    notes.length || failures.length
      ? {
          ...report,
          ...(notes.length ? {reconciliation: notes} : {}),
          ...(failures.length
            ? {progression: {status: 'failed', failures}}
            : {}),
        }
      : report,
  );
}

async function tidyTool(tools: Tools) {
  tools.owner();
  const done = await tidyReleases(tools.db, tools.objects);
  return reply(
    `Removed the membership of ${done.memberships} row(s) and ${done.outputs} saved output(s) and asked the bucket to delete ${done.objects} stored object(s) (${formatBytes(done.bytes)} as recorded, not measured)${done.objectsLeft ? `, ${done.objectsLeft} object(s) left after a bucket error` : ''}${done.skipped ? `; ${done.skipped} blocked for now` : ''}${done.more ? '; more may remain, call again' : ''}.`,
    done,
  );
}

/** Ask the executor to stop the runs a cancellation named. */
async function cancelRuns(tools: Tools, outcomeJson: string) {
  const cancelled: string[] = [];
  const failed: string[] = [];
  await tidyReleases(tools.db, tools.objects);
  const runs = (JSON.parse(outcomeJson) as Outcome).cancel_requested_runs ?? [];
  for (const run of runs)
    (tools.github && (await tools.github.cancel(run))
      ? cancelled
      : failed
    ).push(run);
  return {cancelled, failed};
}

/** Continue unfinished work after a resume; failures are reported, never thrown. */
async function resumeProgress(tools: Tools, taskId: string) {
  const {db, github, objects} = tools;
  const reconciliation = await progressSafely('reconcile', taskId, () =>
    reconcile(db, github, taskId),
  );
  const progression = await progressSafely('advance', taskId, () =>
    advance(db, github, taskId, objects),
  );
  return [reconciliation.failure, progression.failure].filter(
    (failure): failure is ProgressFailure => !!failure,
  );
}

async function controlTaskTool(
  tools: Tools,
  {
    task_id,
    expected_revision,
    action,
  }: {task_id: string; expected_revision: number; action: ControlAction},
) {
  const result = await controlTask(
    tools.db,
    tools.owner(),
    task_id,
    expected_revision,
    action,
  );
  if (result.status !== 'ok')
    return reply(
      result.message,
      {
        status: result.status,
        state: result.task?.state,
        revision: result.task?.revision,
      },
      true,
    );
  const {cancelled, failed} =
    action === 'cancel'
      ? await cancelRuns(tools, result.task.outcome_json)
      : {cancelled: [], failed: []};
  const failures =
    action === 'resume' ? await resumeProgress(tools, task_id) : [];
  const task = (await taskReport(tools.db, tools.owner(), task_id))!;
  const note = failed.length
    ? ` Cancellation of ${failed.length} run(s) did not go through; get_task requests it again.`
    : '';
  return reply(
    `Task ${task.id} is now ${task.state} (revision ${task.revision}).${note}`,
    {
      status: 'ok',
      state: task.state,
      revision: task.revision,
      ...(action === 'cancel'
        ? {runs_cancelled: cancelled, cancel_failed: failed}
        : {}),
      ...(failures.length ? {progression: {status: 'failed', failures}} : {}),
    },
  );
}

/** The single Maintenance MCP server for one authenticated request. */
export function controlServer(
  db: D1Database,
  requester: string | undefined,
  enhancements: boolean,
  github: GitHubActions | null = null,
  objects: ObjectStore | null = null,
) {
  const server = platformServer('control', enhancements, CONTROL_INSTRUCTIONS);
  const owner = () => {
    if (!requester) throw new Error('Task tools need the authenticated owner.');
    return requester;
  };
  const tools: Tools = {db, owner, github, objects};
  server.registerTool(
    'request_task',
    {
      description:
        "Start a Maintenance task from the owner's instruction, or return the existing task for a repeated request key. Returns the task ID and state, or the information still needed.",
      inputSchema: requestSchema,
    },
    request => requestTaskTool(tools, request),
  );
  server.registerTool(
    'get_task',
    {
      description:
        'Without task_id: list open and recent tasks (newest first, bounded pages). With task_id: requested, completed and remaining scope, jobs, checks, selection and limitations.',
      inputSchema: getSchema,
    },
    args => getTaskTool(tools, args),
  );
  server.registerTool(
    'tidy_releases',
    {
      description:
        'Remove what no kept release and no open task needs: the membership of old releases, then unused saved outputs with their stored objects. Bounded per call; call again while more is true. Changes no task and no selection.',
      inputSchema: tidySchema,
    },
    () => tidyTool(tools),
  );
  server.registerTool(
    'control_task',
    {
      description:
        'Pause, cancel or resume a task. Pass the revision you last read; saved outputs are kept.',
      inputSchema: controlSchema,
    },
    args => controlTaskTool(tools, args),
  );
  return server;
}
