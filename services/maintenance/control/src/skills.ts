import type {TaskSkill} from '../../../../packages/shared/src/skills.ts';
import {
  ASK_FIRST,
  ASK_LISTED,
  ADMISSION_RULE,
  BELONGING,
  CANDIDATE,
  CONTROL_RULE,
  EMPTY_LIST,
  EXCLUDE,
  FOLLOW,
  NEVER_INVENT,
  NO_RECIPE,
  ONLY_INSTRUCTED,
  PREPARE,
  RECIPE_FIRST,
  REMOVE,
  REPLACE_CHECK,
  REPLACE_ORDER,
  REPLACE_PART,
  REPLACE_STOP,
  REPLACE_WHEN,
  REPORT,
  ROLLBACK,
  SEND_IN_ORDER,
  STATEMENT_NEEDS,
  SUPERSEDE,
  TIDY,
  TURN,
  VALIDATE,
  type SKILL_NAMES,
} from './guidance.ts';

/** The way of working for each kind of request, composed from the sentences a host without
 *  skills receives with the instructions and the tool descriptions. */

const section = (title: string, rules: string[]) =>
  `${title}:\n${rules.map(rule => `- ${rule}`).join('\n')}`;

const ALWAYS = section('Always', [
  ONLY_INSTRUCTED,
  NEVER_INVENT,
  ADMISSION_RULE,
  ASK_LISTED,
  REPORT,
]);

function skill(
  name: keyof typeof SKILL_NAMES,
  description: string,
  ...parts: string[]
): TaskSkill {
  return Object.freeze({
    name,
    description,
    text: [ALWAYS, ...parts].join('\n\n'),
  });
}

export const CONTROL_SKILLS: readonly TaskSkill[] = Object.freeze([
  skill(
    'add-source',
    'Adding, refreshing, correcting or replacing a source with Maintenance Control, fetching it, preparing it or making a prepared build current: read before such a request.',
    section('Fetching and building', [
      RECIPE_FIRST,
      BELONGING,
      PREPARE,
      ASK_FIRST,
      TURN,
      SEND_IN_ORDER,
      EMPTY_LIST,
      STATEMENT_NEEDS,
      NO_RECIPE,
    ]),
    section('Making a prepared build current', [CANDIDATE]),
    section('Replacing a whole source revision', [
      REPLACE_WHEN,
      REPLACE_CHECK,
      REPLACE_ORDER,
      REPLACE_STOP,
      REPLACE_PART,
    ]),
  ),
  skill(
    'remove-source',
    'Removing a source from current data with Maintenance Control: read before such a request.',
    section('Removing', [REMOVE, EXCLUDE]),
  ),
  skill(
    'restore-data',
    'Rolling back current data or validating a restore with Maintenance Control: read before such a request.',
    section('Restoring', [ROLLBACK, VALIDATE]),
  ),
  skill(
    'follow-tasks',
    'Following, pausing, cancelling, resuming or changing a Maintenance task, and cleaning up old releases: read before such a request.',
    section('Tasks', [FOLLOW, CONTROL_RULE, SUPERSEDE, TIDY]),
  ),
]);
