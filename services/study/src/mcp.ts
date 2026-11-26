import {fromJsonSchema} from '@modelcontextprotocol/server';
import {platformServer} from '../../../packages/shared/src/platform.ts';
import {taskSkills} from '../../../packages/shared/src/skills.ts';
import {
  MODES,
  DEPTHS,
  failure,
  study,
  type StudyRequest,
} from './coordinator.ts';
import {EVIDENCE_FOCUS} from './operators/language.ts';
import {
  CONTINUATION,
  COVERAGE,
  guidance,
  GUIDANCE_TOPICS,
  LANGUAGE_AIDS,
  NOT_OFFERED,
  NUMBERING,
  PASSAGES,
  PROPER_NAMES,
  SELECTED_DATA,
  SKILL_CODE,
  skillNeeded,
  SKILLS,
  STUDY_INSTRUCTIONS,
  SUPERSCRIPTION_RULE,
  WORD_FOCUS,
  WORD_LOOKUPS,
} from './guidance.ts';
import type {StudyReadEnvironment} from './read/bindings.ts';
import {ReadError} from './read/states.ts';

/** What a host sends to the study tool: a study request and the code of its mode's skill. */
type ToolRequest = StudyRequest & {skill_code?: string};

const text = (max: number) => ({type: 'string', minLength: 1, maxLength: max});

export const STUDY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: {
      enum: [...MODES],
      description:
        'What the user wants: translation, passage, exegesis, comparison, word_analysis, word_study, theme, inspect_source or conclusion_check.',
    },
    // Not required by the schema, so that a call without it learns which skill to read.
    skill_code: {...text(64), description: SKILL_CODE},
    focus: {
      enum: [...EVIDENCE_FOCUS],
      description: WORD_FOCUS,
    },
    question: {
      ...text(2000),
      description:
        "The user's question, for context. The tool does not interpret it.",
    },
    references: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: text(80),
      description: PASSAGES,
    },
    search_leads: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      description: `One search per call. ${WORD_LOOKUPS} ${NOT_OFFERED}`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lookup', 'key'],
        properties: {
          lookup: {
            enum: [
              'word',
              'form',
              'lemma',
              'grammar',
              'lexicon',
              'lexicon_entry',
              'grammar_info',
              'proper_name',
              'phrase',
              'proximity',
              'fuzzy',
            ],
          },
          key: {
            ...text(256),
            description: `${PROPER_NAMES} ${LANGUAGE_AIDS}`,
          },
        },
      },
    },
    sources: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: text(200),
      description:
        'Limit to these source revision IDs (as returned in evidence). Default: every selected source.',
    },
    depth: {
      enum: [...DEPTHS],
      description:
        'Breadth of evidence, not answer length. focused leaves out the surrounding chapter. Default standard.',
    },
    language: {
      ...text(35),
      description:
        'Answer language for the user (default en). Evidence stays in the original.',
    },
    requested_result: {
      ...text(500),
      description:
        'What the user wants delivered, for example a full translation with notes.',
    },
    interactive: {
      type: 'boolean',
      description: 'True only if the user asked to go step by step.',
    },
    continuation: {
      type: 'string',
      maxLength: 2048,
      description:
        'Pass the continuation from the previous batch, with the same other arguments.',
    },
  },
} as const;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const reply = (data: unknown) => {
  const isError =
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as {evidence?: unknown}).evidence) &&
    (data as {evidence: unknown[]}).evidence.length === 0 &&
    (data as {release_id?: unknown}).release_id === undefined;
  return {
    content: [{type: 'text' as const, text: JSON.stringify(data)}],
    ...(isError ? {isError: true} : {}),
  };
};

const serveTaskSkills = taskSkills('study', SKILLS);

/** The Study MCP server for one authenticated request: two read-only tools and the skills every
 *  study goes through. */
export async function studyServer(
  env: StudyReadEnvironment,
  enhancements: boolean,
) {
  const server = platformServer('study', enhancements, STUDY_INSTRUCTIONS);
  await serveTaskSkills(server);
  server.registerTool(
    'study',
    {
      title: 'Study Scripture evidence',
      description: [
        'Returns attributed original-language evidence for a study: passages by reference, or exact word occurrences with attributed lexicon, grammar and proper-name evidence. Read-only.',
        'Every study goes through a skill: before the first call, read the skill for your mode to its end (as a skill, or with get_guidance and its name) and pass the skill_code it ends with.',
        CONTINUATION,
        COVERAGE,
        NUMBERING,
        SUPERSCRIPTION_RULE,
        SELECTED_DATA,
      ].join(' '),
      inputSchema: fromJsonSchema<ToolRequest>(
        STUDY_SCHEMA as unknown as Record<string, unknown>,
      ),
      annotations: readOnly,
    },
    async ({skill_code, ...request}: ToolRequest) => {
      const needed = skillNeeded(request.mode, skill_code);
      if (needed)
        return reply(failure(new ReadError('skill_required', needed), request));
      return reply(
        await study(env, request, usage => {
          // Only operational counts go to Workers Logs. Keep the tool response limited to study evidence.
          console.log({
            event: 'study_d1_cache',
            hits: usage.d1CacheHits,
            misses: usage.d1CacheMisses,
            d1_calls: usage.d1Calls,
            d1_rows_read: usage.d1RowsRead,
          });
        }),
      );
    },
  );
  server.registerTool(
    'get_guidance',
    {
      title: 'Study skills',
      description: `Reads a Study skill: the whole way of working for one kind of question, ending with the skill_code the study tool requires. The same text a host loads as a skill. Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}; all (default) lists the skills and the data offered.`,
      inputSchema: fromJsonSchema<{topic?: string}>({
        type: 'object',
        additionalProperties: false,
        properties: {topic: {enum: [...Object.keys(GUIDANCE_TOPICS), 'all']}},
      }),
      annotations: readOnly,
    },
    async ({topic}: {topic?: string}) => ({
      content: [{type: 'text' as const, text: JSON.stringify(guidance(topic))}],
    }),
  );
  return server;
}
