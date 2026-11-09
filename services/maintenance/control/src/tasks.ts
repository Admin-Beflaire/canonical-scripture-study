import { canonicalJson, sha256, type D1Database } from './d1.ts';
import type { InputRef } from './contracts.ts';

/** Task scope, state and owner-instruction resolution (Maintenance Control To-Be §1–2). */
export const TASK_KINDS = ['prepare', 'correct', 'replace', 'remove', 'package', 'incorporate_statement', 'rollback', 'validate_restore'] as const;
export const TASK_STATES = ['queued', 'running', 'paused', 'blocked', 'checked', 'completed', 'cancelled', 'superseded'] as const;
export const OPEN_STATES = ['queued', 'running', 'paused', 'blocked', 'checked'] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskState = typeof TASK_STATES[number];
export type DecisionRef = { kind: 'admission' | 'statement' | 'exclusion' | 'other'; ref: string; subject?: string; name?: string; version?: string };

export interface TaskRequest {
  request_key: string; instruction: string; kind: TaskKind; inputs?: InputRef[]; operations?: string[];
  extent?: Record<string, unknown>; capabilities?: string[]; constraints?: Record<string, unknown>; decision_refs?: DecisionRef[];
  /** Unfinished task this changed instruction replaces (from get_task). */
  supersedes?: string;
}
export interface Scope {
  kind: TaskKind; inputs: InputRef[]; operations: string[]; extent: Record<string, unknown>;
  capabilities: string[]; constraints: Record<string, unknown>; decision_refs: DecisionRef[];
}
export interface Outcome {
  completed_extent: Record<string, unknown>; remaining_extent: Record<string, unknown>;
  limitations: string[]; selection: null | { current_release_id: string | null; became_current: boolean };
  cancel_requested_runs?: string[];
}
export interface TaskRow {
  id: string; requester: string; request_key: string; instruction: string; scope_json: string; basis_digest: string;
  revision: number; state: TaskState; base_release_id: string | null; candidate_release_id: string | null;
  quality_ref: string | null; scope_ref: string | null; outcome_json: string;
}
export type RequestResult =
  | { status: 'created' | 'existing'; task: TaskRow; superseded: string[] }
  | { status: 'needs_information'; missing: string[] }
  | { status: 'conflict'; message: string; task_id: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const inputKey = (ref: InputRef) => `${ref.kind}\u0000${ref.id}`;

/** Normalize the structured request into a finite scope, or say what is missing. */
export function normalizeScope(request: TaskRequest): { scope: Scope; missing: string[] } {
  const missing: string[] = [];
  const inputs = [...new Map((request.inputs ?? []).map(ref => [inputKey(ref), ref])).values()]
    .sort((a, b) => inputKey(a) < inputKey(b) ? -1 : 1);
  const decisions = [...new Map((request.decision_refs ?? []).map(ref => [canonicalJson(ref), ref])).values()]
    .sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1);
  const scope: Scope = {
    kind: request.kind, inputs, operations: uniqueSorted(request.operations ?? []), extent: request.extent ?? {},
    capabilities: uniqueSorted(request.capabilities ?? []), constraints: request.constraints ?? {}, decision_refs: decisions,
  };
  if (!TASK_KINDS.includes(request.kind)) missing.push(`kind: one of ${TASK_KINDS.join(', ')}`);
  if (!ID.test(request.request_key ?? '')) missing.push('request_key: a short stable key for this instruction');
  if (!request.instruction?.trim()) missing.push("instruction: the owner's instruction in his own words");
  for (const value of [...scope.operations, ...scope.capabilities, ...inputs.map(ref => ref.id)])
    if (!ID.test(value)) missing.push(`identifier "${value.slice(0, 40)}": letters, digits and . _ : / - only`);
  const needsInputs = ['prepare', 'correct', 'replace', 'remove', 'package'].includes(request.kind);
  if (needsInputs && inputs.length === 0) missing.push('inputs: which admitted source revisions, artifacts or acquisition routes this concerns');
  if (['prepare', 'correct', 'replace'].includes(request.kind)) {
    if (Object.keys(scope.extent).length === 0) missing.push('extent: the finite native extent (for example which books or units)');
    if (scope.capabilities.length === 0) missing.push('capabilities: which outputs are needed (for example source_text, word_index)');
  }
  if (request.kind === 'incorporate_statement') {
    const statements = decisions.filter(ref => ref.kind === 'statement');
    if (statements.length !== 1 || !statements[0].name || !statements[0].version)
      missing.push('decision_refs: exactly one owner statement approval with name and version');
  }
  return { scope, missing };
}

/** Admission check: a source revision without an eligible admission, or a new acquisition,
 *  needs an explicit owner admission decision reference. Never inferred. */
export async function admissionGaps(db: D1Database, scope: Scope): Promise<string[]> {
  const decided = new Set(scope.decision_refs.filter(ref => ref.kind === 'admission' && ref.subject).map(ref => ref.subject));
  const gaps: string[] = [];
  for (const ref of scope.inputs) {
    if (ref.kind === 'artifact' || decided.has(ref.id)) continue;
    if (ref.kind === 'source_revision') {
      const row = await db.prepare(`SELECT COUNT(*) AS total, SUM(both_hosts_eligible = 1) AS eligible
        FROM admissions WHERE source_revision_id = ?`).bind(ref.id).first<{ total: number; eligible: number | null }>();
      if (row && row.total > 0 && row.eligible === row.total) continue;
    }
    gaps.push(`decision_refs: owner admission decision (kind "admission", subject "${ref.id}") — this source is not admitted for both hosts`);
  }
  return gaps;
}


/** Create the task, or return the existing one for a repeated requester/key with the same scope. */
export async function requestTask(db: D1Database, requester: string, request: TaskRequest): Promise<RequestResult> {
  const { scope, missing } = normalizeScope(request);
  if (missing.length) return { status: 'needs_information', missing };
  const basis = await sha256(canonicalJson(scope));
  const existing = await db.prepare('SELECT * FROM maintenance_tasks WHERE requester = ? AND request_key = ?')
    .bind(requester, request.request_key).first<TaskRow>();
  if (existing) {
    if (existing.basis_digest === basis) return { status: 'existing', task: existing, superseded: [] };
    return { status: 'conflict', task_id: existing.id,
      message: 'This request key was already used with a different scope. Use a new request key for the changed instruction.' };
  }
  const gaps = await admissionGaps(db, scope);
  if (gaps.length) return { status: 'needs_information', missing: gaps };

  const id = `task-${(await sha256(`${requester}\u0000${request.request_key}`)).slice(0, 24)}`;
  const selection = await db.prepare('SELECT current_release_id FROM release_selection WHERE singleton_id = 1')
    .first<{ current_release_id: string | null }>();
  const outcome: Outcome = { completed_extent: {}, remaining_extent: scope.extent, limitations: [], selection: null };
  // A changed instruction names the unfinished task it replaces; nothing is superseded by guesswork.
  let replaced: Pick<TaskRow, 'id' | 'revision'> | null = null;
  if (request.supersedes) {
    replaced = await db.prepare(`SELECT id, revision FROM maintenance_tasks WHERE id = ? AND requester = ?
      AND state IN ('queued','running','paused','blocked','checked')`).bind(request.supersedes, requester).first();
    if (!replaced) return { status: 'needs_information', missing: [`supersedes: "${request.supersedes}" is not an unfinished task of this owner`] };
  }
  // All or nothing in one batch: the old task is superseded only if this request creates the new
  // one, and the new one is created only if the named old task was superseded at the revision read.
  const supersede = replaced ? [db.prepare(`UPDATE maintenance_tasks SET state = 'superseded', revision = revision + 1
    WHERE id = ? AND revision = ? AND state IN ('queued','running','paused','blocked','checked')
      AND NOT EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ?)`).bind(replaced.id, replaced.revision, id)] : [];
  const insert = db.prepare(`INSERT INTO maintenance_tasks(id, requester, request_key, instruction, scope_json, basis_digest,
      revision, state, base_release_id, outcome_json)
    SELECT ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ? WHERE NOT EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND state = 'superseded' AND revision = ?))`)
    .bind(id, requester, request.request_key, request.instruction.trim(), canonicalJson(scope), basis,
      selection?.current_release_id ?? null, canonicalJson(outcome), id,
      replaced?.id ?? null, replaced?.id ?? null, replaced ? replaced.revision + 1 : null);
  const results = await db.batch([...supersede, insert]);
  const inserted = results[results.length - 1];
  const task = await db.prepare('SELECT * FROM maintenance_tasks WHERE id = ?').bind(id).first<TaskRow>();
  if (!task) return { status: 'conflict', task_id: replaced!.id,
    message: 'The task to supersede changed before the new task was recorded. Read it again; nothing was changed.' };
  if (task.basis_digest !== basis || task.request_key !== request.request_key) throw new Error('Task identity collision');
  // A concurrent identical request may have won the insert: report it as existing.
  if (!inserted.meta.changes) return { status: 'existing', task, superseded: [] };
  return { status: 'created', task, superseded: replaced ? [replaced.id] : [] };
}

export type ControlAction = 'pause' | 'cancel' | 'resume';
const TRANSITIONS: Record<ControlAction, readonly TaskState[]> = {
  pause: ['queued', 'running', 'blocked'],
  cancel: ['queued', 'running', 'paused', 'blocked', 'checked'],
  resume: ['paused', 'blocked'],
};
export type ControlResult = { status: 'ok'; task: TaskRow } | { status: 'conflict' | 'not_allowed' | 'not_found'; message: string; task?: TaskRow };

/** Revision-guarded pause/cancel/resume. Checkpoints and saved outputs are never removed. */
export async function controlTask(db: D1Database, requester: string, taskId: string, expectedRevision: number, action: ControlAction): Promise<ControlResult> {
  const task = await getTaskRow(db, requester, taskId);
  if (!task) return { status: 'not_found', message: 'No task with this ID for this owner.' };
  if (task.revision !== expectedRevision) return { status: 'conflict', task, message: `The task changed (now revision ${task.revision}, ${task.state}). Read it again before deciding.` };
  if (!TRANSITIONS[action]?.includes(task.state)) return { status: 'not_allowed', task, message: `Cannot ${action} a ${task.state} task.` };
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const statements = [];
  if (action === 'cancel') {
    // Unsent units are dropped; dispatched runs are recorded for executor cancellation and can never promote.
    const active = await db.prepare(`SELECT run_id FROM maintenance_jobs WHERE task_id = ? AND state IN ('dispatched','running','checkpointed')`)
      .bind(task.id).all<{ run_id: string }>();
    outcome.cancel_requested_runs = active.results.map(row => row.run_id);
    statements.push(db.prepare(`UPDATE maintenance_jobs SET state = 'cancelled' WHERE task_id = ? AND state = 'intended'
      AND EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = ? AND state = 'cancelled' AND revision = ?)`).bind(task.id, task.id, expectedRevision + 1));
  }
  const next: TaskState = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'queued';
  const update = db.prepare(`UPDATE maintenance_tasks SET state = ?, revision = revision + 1, outcome_json = ?
    WHERE id = ? AND revision = ?`).bind(next, canonicalJson(outcome), task.id, expectedRevision);
  const results = await db.batch([update, ...statements]);
  if (!results[0].meta.changes) {
    const latest = await getTaskRow(db, requester, taskId);
    return { status: 'conflict', task: latest ?? undefined, message: 'The task changed while updating. Read it again before deciding.' };
  }
  return { status: 'ok', task: (await getTaskRow(db, requester, taskId))! };
}

export async function getTaskRow(db: D1Database, requester: string, taskId: string) {
  return db.prepare('SELECT * FROM maintenance_tasks WHERE id = ? AND requester = ?').bind(taskId, requester).first<TaskRow>();
}

export const PAGE_SIZE = 20;
/** Open and recent tasks, newest first, in bounded pages. The cursor is opaque to hosts. */
export async function listTasks(db: D1Database, requester: string, cursor?: string) {
  const before = cursor === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(before) || before < 0) throw new Error('Invalid cursor');
  const rows = await db.prepare(`SELECT rowid AS position, id, instruction, state, revision FROM maintenance_tasks
    WHERE requester = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`).bind(requester, before, PAGE_SIZE + 1)
    .all<{ position: number; id: string; instruction: string; state: TaskState; revision: number }>();
  const page = rows.results.slice(0, PAGE_SIZE);
  return {
    tasks: page.map(({ id, instruction, state, revision }) => ({ id, instruction: instruction.length > 120 ? `${instruction.slice(0, 117)}...` : instruction, state, revision })),
    cursor: rows.results.length > PAGE_SIZE ? page[page.length - 1].position.toString(36) : null,
  };
}

/** Full report for one task: requested, completed and remaining scope, jobs, checks and selection. */
export async function taskReport(db: D1Database, requester: string, taskId: string) {
  const task = await getTaskRow(db, requester, taskId);
  if (!task) return null;
  const jobs = await db.prepare(`SELECT unit_id, attempt, kind, state, run_id, checkpoint_ref, result_ref FROM maintenance_jobs
    WHERE task_id = ? ORDER BY unit_id, attempt LIMIT 51`).bind(task.id).all<Record<string, unknown>>();
  const outcome = JSON.parse(task.outcome_json) as Outcome;
  const scope = JSON.parse(task.scope_json) as Scope;
  return {
    id: task.id, revision: task.revision, state: task.state, instruction: task.instruction,
    requested: scope, completed_extent: outcome.completed_extent, remaining_extent: outcome.remaining_extent,
    jobs: jobs.results.slice(0, 50), more_jobs: jobs.results.length > 50,
    checks: { quality: task.quality_ref, scope: task.scope_ref },
    selection: { base_release_id: task.base_release_id, candidate_release_id: task.candidate_release_id, outcome: outcome.selection },
    limitations: outcome.limitations,
    data_current: outcome.selection?.became_current === true,
  };
}
