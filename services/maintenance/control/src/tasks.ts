import {canonicalJson, sha256, type D1Database} from './d1.ts';
import {admissionGaps, type AdmissionSources} from './admission.ts';
import type {ArtifactRef, InputRef} from './contracts.ts';

/** Task scope, state and owner-instruction resolution (Maintenance Control To-Be §1–2). */
/** The steps Control offers. A task lists the ones it needs, in this order; nothing is mandatory.
 *  `remove`, `rollback` and `validate_restore` act on the current data and stand alone. */
export const CHAIN_STEPS = ['fetch', 'analyse', 'build', 'select'] as const;
export const ALONE_STEPS = ['remove', 'rollback', 'validate_restore'] as const;
export const STEPS = [...CHAIN_STEPS, ...ALONE_STEPS] as const;
export const TASK_STATES = [
  'queued',
  'running',
  'paused',
  'blocked',
  'checked',
  'completed',
  'cancelled',
  'superseded',
] as const;
export const OPEN_STATES = [
  'queued',
  'running',
  'paused',
  'blocked',
  'checked',
] as const;
export type Step = (typeof STEPS)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type DecisionRef = {
  kind: 'admission' | 'statement' | 'exclusion' | 'other';
  ref: string;
  subject?: string;
  name?: string;
  version?: string;
};

export interface TaskRequest {
  request_key: string;
  instruction: string;
  steps: Step[];
  inputs?: InputRef[];
  operations?: string[];
  extent?: Record<string, unknown>;
  capabilities?: string[];
  constraints?: Record<string, unknown>;
  decision_refs?: DecisionRef[];
  /** Unfinished task this changed instruction replaces (from get_task). */
  supersedes?: string;
}
export interface Scope {
  steps: Step[];
  inputs: InputRef[];
  operations: string[];
  extent: Record<string, unknown>;
  capabilities: string[];
  constraints: Record<string, unknown>;
  decision_refs: DecisionRef[];
}
export interface Outcome {
  completed_extent: Record<string, unknown>;
  remaining_extent: Record<string, unknown>;
  limitations: string[];
  selection: null | {
    current_release_id: string | null;
    became_current: boolean;
  };
  cancel_requested_runs?: string[];
  /** Separate results: Preparation's quality check and Control's scope check. */
  checks?: {quality?: 'passed'; scope?: 'passed' | 'failed'};
  scope_report?: {problems?: string[]} & Record<string, unknown>;
  /** A build's checked candidate, kept for a later release task. */
  candidate?: {
    release_id: string;
    base_release_id: string | null;
  };
  removal_report?: Record<string, unknown>;
  restore_report?: Record<string, unknown>;
  analysis_report_ref?: ArtifactRef;
  /** The recipe revisions this task started with, one per recipe step. */
  recipe_revision?: string;
  fetch_recipe_revision?: string;
}
export interface TaskRow {
  id: string;
  requester: string;
  request_key: string;
  instruction: string;
  scope_json: string;
  basis_digest: string;
  revision: number;
  state: TaskState;
  base_release_id: string | null;
  candidate_release_id: string | null;
  quality_ref: string | null;
  scope_ref: string | null;
  outcome_json: string;
}
export type RequestResult =
  | {status: 'created' | 'existing'; task: TaskRow; superseded: string[]}
  | {status: 'needs_information'; missing: string[]}
  | {status: 'conflict'; message: string; task_id: string};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const inputKey = (ref: InputRef) => `${ref.kind}\u0000${ref.id}`;

export const has = (scope: Pick<Scope, 'steps'>, step: Step) =>
  scope.steps.includes(step);
/** The owner's approval of the statement a task builds, if it carries one. */
export const statementOf = (scope: Scope) =>
  scope.decision_refs.find(ref => ref.kind === 'statement') ?? null;
const text = (value: unknown) => typeof value === 'string' && ID.test(value);

/** Which steps a task lists, and in which order. */
function stepProblems(steps: Step[]): string[] {
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    !steps.every(step => STEPS.includes(step))
  )
    return [`steps: one or more of ${STEPS.join(', ')}`];
  const alone = steps.some(step => ALONE_STEPS.includes(step as never));
  if (alone && steps.length > 1)
    return [`steps: ${ALONE_STEPS.join(', ')} each stand alone`];
  if (
    steps.includes('analyse') &&
    steps.some(step => step !== 'analyse' && step !== 'fetch')
  )
    return ['steps: analyse runs alone or immediately after fetch'];
  const order = steps.map(step => CHAIN_STEPS.indexOf(step as never));
  if (!alone && order.some((place, i) => i && place <= order[i - 1]))
    return [`steps: each step once, in this order: ${CHAIN_STEPS.join(', ')}`];
  return [];
}

const identifierProblems = (scope: Scope) =>
  [
    ...scope.operations,
    ...scope.capabilities,
    ...scope.inputs.map(ref => ref.id),
  ]
    .filter(value => !ID.test(value))
    .map(
      value =>
        `identifier "${value.slice(0, 40)}": letters, digits and . _ : / - only`,
    );

/** What the fetch and build steps need: sources, a finite extent, a recipe and the outputs wanted. */
function sourceProblems(scope: Scope): string[] {
  const usesFetchRecipe = has(scope, 'fetch') || has(scope, 'analyse');
  const builds = has(scope, 'build');
  const needsSource = (['fetch', 'analyse', 'build', 'remove'] as const).some(
    step => has(scope, step),
  );
  if (!needsSource) return [];
  const missing: string[] = [];
  if (!scope.inputs.length)
    missing.push(
      'inputs: which admitted source revisions, artifacts or acquisition routes this concerns',
    );
  if (has(scope, 'remove')) return missing;
  if (Object.keys(scope.extent).length === 0)
    missing.push(
      'extent: the finite native extent (for example which books or units)',
    );
  if (usesFetchRecipe && typeof scope.constraints.fetch_recipe !== 'string')
    missing.push('constraints.fetch_recipe: the reviewed fetch recipe');
  if (builds && typeof scope.constraints.recipe !== 'string')
    missing.push('constraints.recipe: the reviewed build recipe');
  if (builds && scope.capabilities.length === 0)
    missing.push(
      'capabilities: which outputs are needed (for example source_text, word_index)',
    );
  if (!builds && scope.capabilities.length)
    missing.push(
      'capabilities: a task that builds nothing makes no outputs, so it names none',
    );
  return missing;
}

/** What the select and the stand-alone steps need. */
function actionProblems(scope: Scope): string[] {
  const missing: string[] = [];
  const candidate = scope.constraints.candidate;
  if (has(scope, 'select') && !has(scope, 'build') && !text(candidate))
    missing.push(
      'constraints.candidate: the task ID of the checked build to make current',
    );
  if (has(scope, 'build') && candidate !== undefined)
    missing.push(
      'constraints.candidate: only a task that makes current without building names a finished build',
    );
  if (
    has(scope, 'remove') &&
    scope.inputs.some(ref => ref.kind !== 'source_revision')
  )
    missing.push(
      'inputs: name the source revisions to remove (kind "source_revision")',
    );
  const wanted = scope.constraints.select_release;
  if (has(scope, 'validate_restore') && wanted !== undefined && !text(wanted))
    missing.push(
      'constraints.select_release: the ID of the restored release to select, only if the owner asked to select it',
    );
  return missing;
}

/** An owner statement approval belongs to the task that builds the statement. */
function statementProblems(scope: Scope): string[] {
  const statements = scope.decision_refs.filter(
    ref => ref.kind === 'statement',
  );
  if (!statements.length) return [];
  const [only] = statements;
  return statements.length === 1 &&
    only.name &&
    only.version &&
    has(scope, 'build')
    ? []
    : [
        'decision_refs: exactly one owner statement approval with name and version, on a task that builds',
      ];
}

/** Normalize the structured request into a finite scope, or say what is missing. */
export function normalizeScope(request: TaskRequest): {
  scope: Scope;
  missing: string[];
} {
  const byKey = <T>(items: T[] | undefined, key: (item: T) => string) =>
    [...new Map((items ?? []).map(item => [key(item), item])).values()].sort(
      (a, b) => (key(a) < key(b) ? -1 : 1),
    );
  const scope: Scope = {
    steps: Array.isArray(request.steps) ? request.steps : [],
    inputs: byKey(request.inputs, inputKey),
    operations: uniqueSorted(request.operations ?? []),
    extent: request.extent ?? {},
    capabilities: uniqueSorted(request.capabilities ?? []),
    constraints: request.constraints ?? {},
    decision_refs: byKey(request.decision_refs, canonicalJson),
  };
  const stepErrors = stepProblems(request.steps);
  const missing = [...stepErrors];
  if (!ID.test(request.request_key ?? ''))
    missing.push('request_key: a short stable key for this instruction');
  if (!request.instruction?.trim())
    missing.push("instruction: the owner's instruction in his own words");
  if (!stepErrors.length)
    missing.push(
      ...identifierProblems(scope),
      ...sourceProblems(scope),
      ...actionProblems(scope),
      ...statementProblems(scope),
    );
  return {scope, missing};
}

type Replaced = Pick<TaskRow, 'id' | 'revision'>;

/** The task an earlier request with the same key made, if any: the same scope is the same task. */
async function existingRequest(
  db: D1Database,
  requester: string,
  request: TaskRequest,
  basis: string,
): Promise<RequestResult | null> {
  const existing = await db
    .prepare(
      'SELECT * FROM maintenance_tasks WHERE requester = ? AND request_key = ?',
    )
    .bind(requester, request.request_key)
    .first<TaskRow>();
  if (!existing) return null;
  if (existing.basis_digest === basis)
    return {status: 'existing', task: existing, superseded: []};
  return {
    status: 'conflict',
    task_id: existing.id,
    message:
      'This request key was already used with a different scope. Use a new request key for the changed instruction.',
  };
}

/** The statements that record a task: the superseded task changes only if this request creates
 *  the new one, and the new one is created only if the named old task was superseded at the
 *  revision read. All or nothing in one batch. */
function recordStatements(
  db: D1Database,
  task: {
    id: string;
    requester: string;
    request: TaskRequest;
    scope: Scope;
    basis: string;
    base: string | null;
    outcome: Outcome;
  },
  replaced: Replaced | null,
) {
  const supersede = replaced
    ? [
        db
          .prepare(
            `UPDATE maintenance_tasks SET state = 'superseded', revision = revision + 1
    WHERE id = ? AND revision = ? AND state IN ('queued','running','paused','blocked','checked')
      AND NOT EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ?)`,
          )
          .bind(replaced.id, replaced.revision, task.id),
      ]
    : [];
  const insert = db
    .prepare(
      `INSERT INTO maintenance_tasks(id, requester, request_key, instruction, scope_json, basis_digest,
      revision, state, base_release_id, outcome_json)
    SELECT ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ? WHERE NOT EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND state = 'superseded' AND revision = ?))`,
    )
    .bind(
      task.id,
      task.requester,
      task.request.request_key,
      task.request.instruction.trim(),
      canonicalJson(task.scope),
      task.basis,
      task.base,
      canonicalJson(task.outcome),
      task.id,
      replaced?.id ?? null,
      replaced?.id ?? null,
      replaced ? replaced.revision + 1 : null,
    );
  return [...supersede, insert];
}

/** A changed instruction names the unfinished task it replaces; nothing is superseded by guesswork. */
function unfinishedTask(db: D1Database, requester: string, id: string) {
  return db
    .prepare(
      `SELECT id, revision FROM maintenance_tasks WHERE id = ? AND requester = ?
    AND state IN ('queued','running','paused','blocked','checked')`,
    )
    .bind(id, requester)
    .first<Replaced>();
}

/** Create the task, or return the existing one for a repeated requester/key with the same scope. */
export async function requestTask(
  db: D1Database,
  requester: string,
  request: TaskRequest,
  sources: AdmissionSources = {github: null, objects: null},
): Promise<RequestResult> {
  const {scope, missing} = normalizeScope(request);
  if (missing.length) return {status: 'needs_information', missing};
  const basis = await sha256(canonicalJson(scope));
  const earlier = await existingRequest(db, requester, request, basis);
  if (earlier) return earlier;
  const gaps = await admissionGaps(db, scope, sources);
  if (gaps.length) return {status: 'needs_information', missing: gaps};

  const id = `task-${(await sha256(`${requester}\u0000${request.request_key}`)).slice(0, 24)}`;
  const selected = await db
    .prepare(
      'SELECT current_release_id FROM release_selection WHERE singleton_id = 1',
    )
    .first<{current_release_id: string | null}>();
  const outcome: Outcome = {
    completed_extent: {},
    remaining_extent: scope.extent,
    limitations: [],
    selection: null,
  };
  const replaced = request.supersedes
    ? await unfinishedTask(db, requester, request.supersedes)
    : null;
  if (request.supersedes && !replaced)
    return {
      status: 'needs_information',
      missing: [
        `supersedes: "${request.supersedes}" is not an unfinished task of this owner`,
      ],
    };
  const results = await db.batch(
    recordStatements(
      db,
      {
        id,
        requester,
        request,
        scope,
        basis,
        base: selected?.current_release_id ?? null,
        outcome,
      },
      replaced,
    ),
  );
  const inserted = results[results.length - 1];
  const task = await db
    .prepare('SELECT * FROM maintenance_tasks WHERE id = ?')
    .bind(id)
    .first<TaskRow>();
  if (!task)
    return {
      status: 'conflict',
      task_id: replaced!.id,
      message:
        'The task to supersede changed before the new task was recorded. Read it again; nothing was changed.',
    };
  if (task.basis_digest !== basis || task.request_key !== request.request_key)
    throw new Error('Task identity collision');
  // A concurrent identical request may have won the insert: report it as existing.
  if (!inserted.meta.changes) return {status: 'existing', task, superseded: []};
  return {status: 'created', task, superseded: replaced ? [replaced.id] : []};
}

export type ControlAction = 'pause' | 'cancel' | 'resume';
const TRANSITIONS: Record<ControlAction, readonly TaskState[]> = {
  pause: ['queued', 'running', 'blocked', 'checked'],
  cancel: ['queued', 'running', 'paused', 'blocked', 'checked'],
  resume: ['paused', 'blocked'],
};
export type ControlResult =
  | {status: 'ok'; task: TaskRow}
  | {
      status: 'conflict' | 'not_allowed' | 'not_found';
      message: string;
      task?: TaskRow;
    };

/** Revision-guarded pause/cancel/resume. Saved outputs are never removed. */
export async function controlTask(
  db: D1Database,
  requester: string,
  taskId: string,
  expectedRevision: number,
  action: ControlAction,
): Promise<ControlResult> {
  const task = await getTaskRow(db, requester, taskId);
  if (!task)
    return {
      status: 'not_found',
      message: 'No task with this ID for this owner.',
    };
  if (task.revision !== expectedRevision)
    return {
      status: 'conflict',
      task,
      message: `The task changed (now revision ${task.revision}, ${task.state}). Read it again before deciding.`,
    };
  if (!TRANSITIONS[action]?.includes(task.state))
    return {
      status: 'not_allowed',
      task,
      message: `Cannot ${action} a ${task.state} task.`,
    };
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const statements = [];
  if (action === 'cancel') {
    // Unsent units are dropped; dispatched runs are recorded for executor cancellation and can never promote.
    const active = await db
      .prepare(
        `SELECT run_id FROM maintenance_jobs WHERE task_id = ? AND state IN ('dispatched','running')`,
      )
      .bind(task.id)
      .all<{run_id: string}>();
    outcome.cancel_requested_runs = active.results.map(row => row.run_id);
    statements.push(
      db
        .prepare(
          `UPDATE maintenance_jobs SET state = 'cancelled' WHERE task_id = ? AND state = 'intended'
      AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND state = 'cancelled' AND revision = ?)`,
        )
        .bind(task.id, task.id, expectedRevision + 1),
    );
  }
  const next: TaskState =
    action === 'pause'
      ? 'paused'
      : action === 'cancel'
        ? 'cancelled'
        : 'queued';
  const update = db
    .prepare(
      `UPDATE maintenance_tasks SET state = ?, revision = revision + 1, outcome_json = ?
    WHERE id = ? AND revision = ?`,
    )
    .bind(next, canonicalJson(outcome), task.id, expectedRevision);
  const results = await db.batch([update, ...statements]);
  if (!results[0].meta.changes) {
    const latest = await getTaskRow(db, requester, taskId);
    return {
      status: 'conflict',
      task: latest ?? undefined,
      message:
        'The task changed while updating. Read it again before deciding.',
    };
  }
  return {status: 'ok', task: (await getTaskRow(db, requester, taskId))!};
}

export async function getTaskRow(
  db: D1Database,
  requester: string,
  taskId: string,
) {
  return db
    .prepare('SELECT * FROM maintenance_tasks WHERE id = ? AND requester = ?')
    .bind(taskId, requester)
    .first<TaskRow>();
}

export const PAGE_SIZE = 20;
/** Open and recent tasks, newest first, in bounded pages. The cursor is opaque to hosts. */
export async function listTasks(
  db: D1Database,
  requester: string,
  cursor?: string,
) {
  const before =
    cursor === undefined
      ? Number.MAX_SAFE_INTEGER
      : Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(before) || before < 0)
    throw new Error('Invalid cursor');
  const rows = await db
    .prepare(
      `SELECT rowid AS position, id, instruction, state, revision FROM maintenance_tasks
    WHERE requester = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
    )
    .bind(requester, before, PAGE_SIZE + 1)
    .all<{
      position: number;
      id: string;
      instruction: string;
      state: TaskState;
      revision: number;
    }>();
  const page = rows.results.slice(0, PAGE_SIZE);
  return {
    tasks: page.map(({id, instruction, state, revision}) => ({
      id,
      instruction:
        instruction.length > 120
          ? `${instruction.slice(0, 117)}...`
          : instruction,
      state,
      revision,
    })),
    cursor:
      rows.results.length > PAGE_SIZE
        ? page[page.length - 1].position.toString(36)
        : null,
  };
}

/** The error record in a diagnostic message, or a note that the result predates records. */
function recordOf(message: unknown): {record: unknown} | {message: string} {
  try {
    const record =
      typeof message === 'string' && message.length <= 1000
        ? JSON.parse(message)
        : null;
    if (
      record &&
      typeof record === 'object' &&
      (record as {v?: unknown}).v === 1
    )
      return {record};
  } catch {
    /* free text from before records */
  }
  return {
    message: 'This result predates error records; only its code is kept.',
  };
}

/** Full report for one task: requested, completed and remaining scope, jobs, checks and selection. */
export async function taskReport(
  db: D1Database,
  requester: string,
  taskId: string,
) {
  const task = await getTaskRow(db, requester, taskId);
  if (!task) return null;
  const jobs = await db
    .prepare(
      `SELECT unit_id, attempt, kind, state, run_id, result_ref, result_json FROM maintenance_jobs
    WHERE task_id = ? ORDER BY unit_id, attempt LIMIT 51`,
    )
    .bind(task.id)
    .all<{
      unit_id: string;
      attempt: number;
      kind: string;
      state: string;
      run_id: string | null;
      result_ref: string | null;
      result_json: string | null;
    }>();
  // A failed unit's diagnostic is the safe error record built where the error was caught, so it is
  // shown as stored. Results from before the record only carry free text: keep their code.
  const diagnostics = (raw: unknown) => {
    if (typeof raw !== 'string') return [];
    try {
      const value = JSON.parse(raw) as {diagnostics?: unknown};
      if (!Array.isArray(value.diagnostics)) return [];
      return value.diagnostics.slice(0, 32).flatMap((d: unknown) => {
        if (!d || typeof d !== 'object') return [];
        const {code, message} = d as {code?: unknown; message?: unknown};
        if (typeof code !== 'string' || !/^[A-Za-z0-9._:/-]{1,200}$/.test(code))
          return [];
        return [{code, ...recordOf(message)}];
      });
    } catch {
      return [];
    }
  };
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  return {
    id: task.id,
    revision: task.revision,
    state: task.state,
    instruction: task.instruction,
    requested: scope,
    completed_extent: outcome.completed_extent,
    remaining_extent: outcome.remaining_extent,
    jobs: jobs.results.slice(0, 50).map(({result_json, ...job}) => ({
      ...job,
      diagnostics: diagnostics(result_json),
    })),
    more_jobs: jobs.results.length > 50,
    checks: {
      quality:
        outcome.checks?.quality ?? (task.quality_ref ? 'passed' : 'not run'),
      quality_receipt: task.quality_ref,
      scope: outcome.checks?.scope ?? 'not run',
      scope_receipt: task.scope_ref,
      ...(outcome.scope_report?.problems?.length
        ? {scope_problems: outcome.scope_report.problems.slice(0, 20)}
        : {}),
    },
    selection: {
      base_release_id: task.base_release_id,
      candidate_release_id: task.candidate_release_id,
      outcome: outcome.selection,
    },
    limitations: outcome.limitations,
    analysis_report_ref: outcome.analysis_report_ref,
    data_current: outcome.selection?.became_current === true,
  };
}
