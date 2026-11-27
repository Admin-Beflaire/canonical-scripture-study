import {currentSources} from './current-sources.ts';
import {describeRecipe, findRecipes} from './recipe-guide.ts';
import {fromJsonSchema} from '@modelcontextprotocol/server';
import {reportError} from '../../../../packages/shared/src/error-record.ts';
import {platformServer} from '../../../../packages/shared/src/platform.ts';
import {taskSkills} from '../../../../packages/shared/src/skills.ts';
import type {D1Database} from './d1.ts';
import {
  GitHubError,
  readOnce,
  type GitHubActions,
  type RecipeFiles,
} from './github.ts';
import {formatBytes, tidyReleases} from './cleanup.ts';
import {advance, reconcile} from './progress.ts';
import {
  nextAction,
  CONTROL_INSTRUCTIONS,
  DECISION_REF_MAX,
  FIELD_DESCRIPTIONS,
  TOOL_DESCRIPTIONS,
} from './guidance.ts';
import {CONTROL_SKILLS} from './skills.ts';
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
    ref: {type: 'string', minLength: 1, maxLength: DECISION_REF_MAX},
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
    request_key: {...id, description: FIELD_DESCRIPTIONS.request_key},
    instruction: {
      type: 'string',
      minLength: 1,
      maxLength: 4000,
      description: FIELD_DESCRIPTIONS.instruction,
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {enum: [...STEPS]},
      description: FIELD_DESCRIPTIONS.steps,
    },
    inputs: {
      type: 'array',
      maxItems: 64,
      items: inputRef,
      description: FIELD_DESCRIPTIONS.inputs,
    },
    operations: {type: 'array', maxItems: 32, items: id},
    extent: {
      type: 'object',
      maxProperties: 64,
      description: FIELD_DESCRIPTIONS.extent,
    },
    capabilities: {
      type: 'array',
      maxItems: 32,
      items: id,
      description: FIELD_DESCRIPTIONS.capabilities,
    },
    constraints: {
      type: 'object',
      maxProperties: 32,
      description: FIELD_DESCRIPTIONS.constraints,
    },
    decision_refs: {
      type: 'array',
      maxItems: 16,
      items: decisionRef,
      description: FIELD_DESCRIPTIONS.decision_refs,
    },
    supersedes: {...id, description: FIELD_DESCRIPTIONS.supersedes},
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
interface RecipeArgs {
  recipe?: string;
  find?: string;
  sources_after?: string;
  prepare_only?: boolean;
}
const recipeSchema = fromJsonSchema<RecipeArgs>({
  type: 'object',
  additionalProperties: false,
  properties: {
    recipe: {
      ...id,
      description: 'A recipe ID: returns the requests to send for it.',
    },
    find: {
      type: 'string',
      maxLength: 60,
      description:
        'Without recipe: only recipe IDs and current source revisions containing this word.',
    },
    sources_after: {
      ...id,
      description:
        'With find: next_sources_after from the page before, for more current sources.',
    },
    prepare_only: {
      type: 'boolean',
      description:
        'With a build recipe: the owner wants it prepared without making it current.',
    },
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
  const result = await requestTask(db, tools.owner(), request, {
    github,
    objects,
  });
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

async function recipeList(
  db: D1Database,
  github: RecipeFiles,
  args: RecipeArgs,
) {
  const found = await findRecipes(github, args.find);
  const current = args.find
    ? await currentSources(db, args.find, args.sources_after)
    : {};
  return reply(
    `${found.recipes.length} recipe(s)${found.more ? `, ${found.more} more: add a word in find` : ''}. Ask again with one as recipe.`,
    {...found, ...current},
  );
}

async function recipeAnswer(
  tools: Tools,
  github: RecipeFiles,
  id: string,
  prepareOnly?: boolean,
) {
  const {db, objects} = tools;
  const found = await describeRecipe(
    {db, github: readOnce(github), objects},
    id,
    prepareOnly,
  );
  if (!found.found) return reply(found.message, found, true);
  return reply(
    `Recipe ${found.recipe} does a ${found.does}. ${nextAction(found, !!prepareOnly)}`,
    found,
  );
}

async function recipeTool(tools: Tools, args: RecipeArgs) {
  tools.owner();
  const {db, github} = tools;
  if (!github)
    return reply('Recipes are not available: GitHub is not set up.', {}, true);
  try {
    return args.recipe
      ? await recipeAnswer(tools, github, args.recipe, args.prepare_only)
      : await recipeList(db, github, args);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return reply('GitHub did not answer; ask again in a moment.', {}, true);
  }
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

const serveTaskSkills = taskSkills('control', CONTROL_SKILLS);

/** The single Maintenance MCP server for one authenticated request: the task tools and the skill
 *  for each kind of request. */
export async function controlServer(
  db: D1Database,
  requester: string | undefined,
  enhancements: boolean,
  github: GitHubActions | null = null,
  objects: ObjectStore | null = null,
) {
  const server = platformServer('control', enhancements, CONTROL_INSTRUCTIONS);
  await serveTaskSkills(server);
  const owner = () => {
    if (!requester) throw new Error('Task tools need the authenticated owner.');
    return requester;
  };
  const tools: Tools = {db, owner, github, objects};
  server.registerTool(
    'request_task',
    {
      description: TOOL_DESCRIPTIONS.request_task,
      inputSchema: requestSchema,
    },
    request => requestTaskTool(tools, request),
  );
  server.registerTool(
    'get_task',
    {
      description: TOOL_DESCRIPTIONS.get_task,
      inputSchema: getSchema,
    },
    args => getTaskTool(tools, args),
  );
  server.registerTool(
    'get_recipe',
    {
      description: TOOL_DESCRIPTIONS.get_recipe,
      inputSchema: recipeSchema,
    },
    args => recipeTool(tools, args),
  );
  server.registerTool(
    'tidy_releases',
    {
      description: TOOL_DESCRIPTIONS.tidy_releases,
      inputSchema: tidySchema,
    },
    () => tidyTool(tools),
  );
  server.registerTool(
    'control_task',
    {
      description: TOOL_DESCRIPTIONS.control_task,
      inputSchema: controlSchema,
    },
    args => controlTaskTool(tools, args),
  );
  return server;
}
