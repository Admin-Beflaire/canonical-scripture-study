/** Everything Control tells an AI host: server instructions, tool and field descriptions and
 *  the texts of its skills. A skill is an addition: every rule in one is also complete in the
 *  instructions or in a tool's or field's description. Hosts cut long text, so the order
 *  matters: the instructions open with the rules that must never be lost (first 512
 *  characters), hold all that is needed within 2,048, and add only background that may be
 *  missed up to 4,096. A rule for one tool or field lives in its description. */

/** The longest decision reference request_task accepts; the guidance quotes the same number. */
export const DECISION_REF_MAX = 200;

export const ADMISSION_RULE =
  'A general instruction to run a task is not an admission; when no admission is recorded, ask the owner.';

/** The rules that the instructions, the descriptions, the answers and the skills share, each
 *  said once. */
export const ONLY_INSTRUCTED =
  "Use these tools only on the owner's explicit instruction.";
export const RECIPE_FIRST =
  'For a fetch or build, start with get_recipe and send its requests to request_task.';
export const NEVER_INVENT =
  'Never guess an ID or value, and never create an approval: admission, exclusion and statement approvals are decision references the owner gives.';
export const ASK_LISTED =
  'If a result is "needs_information", ask exactly the listed questions.';
export const REPORT =
  'Report to the owner plainly and separately: received, prepared, quality-checked, scope-checked, partial or current.';

export const BELONGING =
  'Adding, refreshing or correcting a source runs every build recipe that belongs to it: call get_recipe for each one the notes name, in the stated order.';
export const PREPARE =
  'When the owner wants a build prepared without making it current, give get_recipe prepare_only.';
export const EMPTY_LIST =
  'An empty requests list means there is nothing to send: tell the owner what the notes say.';
export const NO_RECIPE =
  'A source, statement or study package without a recipe cannot be a task: say that there is no recipe; writing one is repository work.';
export const STATEMENT_NEEDS =
  "A statement build needs the owner's statement approval.";
export const CANDIDATE =
  'To make a prepared build current, find its task with get_task and send request_task with steps ["select"] and constraints.candidate, without inputs.';

export const REPLACE_WHEN =
  'A newer version of a source is a new source revision; it replaces an old one only when the owner says so.';
export const REPLACE_CHECK =
  'Before you send anything for a replacement, call get_recipe with find to see what current data holds from the old revision, then get_recipe for each build recipe of the new revision that gives a part of it; when a part has no recipe, send nothing with replaces and name the part.';
export const REPLACE_ORDER =
  'Send those builds in order, checking each with get_task. Only the last names the old revision in constraints.replaces; until it is current, Study reads both revisions.';
export const REPLACE_STOP =
  'A failed or blocked task ends a replacement: report what became current and what did not, as a partial result.';
export const REPLACE_PART =
  'Part of a revision cannot be replaced, nor can a language aid, whose records do not show which content a new version keeps: send nothing with replaces and say so. Adding the new version beside the old one and removing data are separate instructions that only the owner gives.';

export const REMOVE =
  'To remove a source, call get_recipe with find, confirm with the owner which current source revisions he means, then send request_task with steps ["remove"] and those source revisions as inputs.';
export const EXCLUDE =
  'Add an exclusion decision only when the owner decided to keep the source out, one per source revision.';
export const ROLLBACK =
  'To roll back, send request_task with steps ["rollback"]: it selects the previous release when that still validates.';
export const VALIDATE =
  'To validate a restore, send request_task with steps ["validate_restore"]; add constraints.select_release only when the owner asks to select that release.';

export const FOLLOW =
  "get_task lists the tasks, or shows one task's state, checks and progress.";
export const CONTROL_RULE =
  'control_task pauses, cancels or resumes: pass the revision you last read; a conflict means the task changed, so read it again before deciding.';
export const SUPERSEDE =
  'To change the instruction of an unfinished task, read it with get_task, then send the new request with a new request_key and its ID in supersedes.';
export const TIDY = 'To clean up, call tidy_releases again while more is true.';

export const SEND_IN_ORDER =
  'Send the requests in the listed order, one task each with its own request_key, and each only after get_task shows the one before has completed.';
export const ALREADY_OBTAINED =
  'Already obtained: the original is kept and its recorded admission still applies, so there is nothing to send.';
export const ASK_FIRST =
  'Ask the owner every question in owner_decisions before you send anything.';
export const admissionQuestion = (id: string, why: string) =>
  `Does the owner admit ${id}? ${why[0].toUpperCase()}${why.slice(1)}. His decision goes in decision_refs: kind "admission", subject "${id}".`;
export const exclusionQuestion = (id: string) =>
  `The owner excluded ${id}, which covers a source of this build. Does he lift that exclusion? Only his decision in decision_refs (kind "exclusion", subject "${id}") on the request lifts it.`;
export const STATEMENT_QUESTION =
  'Which statement name and version does the owner approve? His approval goes in decision_refs: kind "statement", with name and version.';
export const unlistedNote = (kind: string, id: string) =>
  `No fetch recipe on main lists ${kind} ${id}; ask the owner how that original is obtained.`;
export const runOrderNote = (names: string[]) =>
  `These recipes read the same original over the same extent and give other capabilities: ${names.join(', ')}. Adding or refreshing the source runs each, in this order, with get_recipe for each.`;
export const alternativesNote = (id: string, others: string[]) =>
  `${others.join(', ')} gives the same capabilities over the same extent as ${id}: ask the owner which one to run.`;

/** The skills, one for each kind of request; skills.ts holds their texts. */
export const SKILL_NAMES = {
  'add-source':
    'add, refresh, correct or replace a source, fetch, prepare, make current',
  'remove-source': 'remove a source',
  'restore-data': 'roll back, validate a restore',
  'follow-tasks': 'status, pause, cancel, resume, change, clean up',
} as const;
const SKILL_ROUTES = `Each request belongs to one skill; load it where the host offers skills. ${Object.entries(
  SKILL_NAMES,
)
  .map(([name, covers]) => `${name} (${covers})`)
  .join('; ')}.`;

/** Needed to use Control correctly. */
const ESSENTIALS = `Canonical Scripture Study — Maintenance Control. ${ONLY_INSTRUCTED} ${RECIPE_FIRST} ${NEVER_INVENT} ${ADMISSION_RULE} ${ASK_LISTED}

${SKILL_ROUTES}

Tools (each tool and field description holds its rules; read them before the call):
- get_recipe (read only): lists recipes and current sources, or gives one recipe's requests in order, with exact input IDs and the decisions to ask first. Do not read code, designs or the repository for this.
- request_task: starts a task; one request_key per instruction.
- get_task: the task list, or one task's state, checks and progress.
- control_task: pause, cancel or resume.
- tidy_releases: removes what nothing needs any more.

A task lists only the steps it needs, in order: fetch, build, select; remove, rollback and validate_restore each stand alone. A task that lists select makes its checked result current at once: the owner's instruction is the permission, no second go is needed. Work runs by itself in GitHub Actions and continues without an open chat; check back with get_task.

${REPORT}`;

/** Useful to explain what a task is doing; correct use does not depend on it. */
const BACKGROUND = `How a task runs:
- Each unit's result starts the next, and failed units are retried up to three times. An input that is not registered is not retried: the task is blocked at once and the message names it.
- When every unit of a build has passed the quality check, Control checks the scope itself: the outputs are exactly what was instructed, from the named sources, over the whole extent, with the capabilities available, admitted, stored and not excluded. A failed check blocks the task with the reasons and leaves current data unchanged.
- If another build became current in between, Control builds the release again on it, checks it again and retries a few times.`;

/** Sent on initialize. */
export const CONTROL_INSTRUCTIONS = `${ESSENTIALS}\n\n${BACKGROUND}`;

export const TOOL_DESCRIPTIONS = {
  request_task: `Start a Maintenance task from the owner's instruction, or return the existing task for a repeated request key. For a fetch or build, ask get_recipe first and send its requests, adding request_key, the instruction and the owner's decision references; select, remove, rollback and validate_restore on their own have no recipe. Returns the task ID and state, or the information still needed. ${STATEMENT_NEEDS} ${CANDIDATE} ${REMOVE} ${ROLLBACK} ${VALIDATE}`,
  get_task: `${FOLLOW} Without task_id: open and recent tasks (newest first, bounded pages; pass the returned cursor for the next page). With task_id: requested, completed and remaining scope, jobs, checks, selection, limitations and whether data became current; it also reconciles interrupted work.`,
  get_recipe: `Read only. Without recipe: list recipe IDs, optionally containing a word (for example a book or source name); with find, also the source revisions in current data whose ID contains it, with the capabilities and extent held, in pages. With recipe: whether it fetches or builds, requests (the request_task fields to send: steps, constraints, extent, capabilities, exact input IDs) and owner_decisions (what to ask first). A build's requests fetch each original that is not kept, build and select; with prepare_only none selects. ${EMPTY_LIST} ${ASK_FIRST} ${SEND_IN_ORDER} ${BELONGING} ${PREPARE} ${NO_RECIPE}`,
  tidy_releases: `Remove what no kept release and no open task needs: the membership of old releases, then unused saved outputs with their stored objects. It also runs when a task ends. Each call does a bounded part. ${TIDY} Skipped outputs are blocked by another output and are left. Changes no task and no selection.`,
  control_task: `${CONTROL_RULE} Pause stops new units and promotion; cancel also stops running ones; resume continues only unfinished units. Saved outputs are kept.`,
};

/** request_task's fields. */
export const FIELD_DESCRIPTIONS = {
  request_key:
    'Short stable key, one per instruction. Repeating it with the same scope safely returns the same task; a changed instruction needs a new key.',
  instruction: "The owner's instruction in his own words.",
  steps:
    'The steps this task needs, in order, and nothing more. fetch keeps an original (recipe in constraints.fetch_recipe). build makes checked outputs (recipe in constraints.recipe). select makes the build current; without it a build ends checked and waits, and a later task with only select and constraints.candidate, no inputs, makes it current. Examples: ["fetch"], ["build","select"], ["fetch","build","select"], ["select"]. Each of these stands alone: remove (inputs are the source revisions to remove; when the owner decided to exclude them, add one exclusion decision_ref per source revision), rollback (selects the previous release if it still validates), validate_restore (checks restored releases and blocks restored open tasks).',
  inputs:
    'For fetch and build, the exact input IDs get_recipe returns: admitted source revisions, registered artifacts or acquisition routes (a task that fetches and builds names the inputs of both). For remove, the source revisions to remove. A select, rollback or validate_restore task needs none.',
  extent:
    "Finite native extent. For a build, exactly the build recipe's native_extent, also when the task fetches first (the fetch keeps its original under its own recipe extent). For a fetch alone, as get_recipe returns it.",
  capabilities:
    'The outputs a build must make, only ones its recipe provides (get_recipe lists them). A task that builds nothing names none. A package build holds source references only, never answers.',
  constraints: `fetch_recipe: the reviewed recipe a fetch step runs. recipe: the reviewed recipe a build step runs. candidate: the task ID of the checked build to make current. select_release: with validate_restore, the restored release to select, only if the owner asked. replaces: on a build, the source revisions it replaces; the task is blocked unless the new data covers everything the old gave. ${REPLACE_WHEN} ${REPLACE_CHECK} ${REPLACE_ORDER} ${REPLACE_STOP} ${REPLACE_PART}`,
  decision_refs: `Owner decisions he gave you; never create one. admission: subject is the input id, ref a short reference to his decision to admit that source (for example the issue or comment recording it, at most ${DECISION_REF_MAX} characters). ${ADMISSION_RULE} exclusion: only for an exclusion the owner decided, one per source revision as subject; on a remove it keeps that source out of later releases and rollbacks, and on a later build it lifts that. ${EXCLUDE} statement: with name and version, on the build of that statement.`,
  supersedes: `ID of the unfinished task this request replaces: a changed instruction, or a task blocked because it left out a recipe's input. ${SUPERSEDE}`,
};
