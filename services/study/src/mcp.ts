import {fromJsonSchema} from '@modelcontextprotocol/server';
import {platformServer} from '../../../packages/shared/src/platform.ts';
import {taskSkills} from '../../../packages/shared/src/skills.ts';
import {MODES, DEPTHS, study, type StudyRequest} from './coordinator.ts';
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
  STUDY_INSTRUCTIONS,
  SUPERSCRIPTION_RULE,
  TASKS,
  WORD_FOCUS,
  WORD_LOOKUPS,
} from './guidance.ts';
import type {StudyReadEnvironment} from './read/bindings.ts';

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

const serveTaskSkills = taskSkills('study', TASKS);

/** The Study MCP server for one authenticated request: two read-only tools, their guidance and
 *  the task texts as skills. */
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
        CONTINUATION,
        COVERAGE,
        NUMBERING,
        SUPERSCRIPTION_RULE,
        SELECTED_DATA,
        'Before translating, follow translation_rules in the result and get_guidance topic "translation": your own working translation from the original, not a standard translation.',
      ].join(' '),
      inputSchema: fromJsonSchema<StudyRequest>(
        STUDY_SCHEMA as unknown as Record<string, unknown>,
      ),
      annotations: readOnly,
    },
    async (request: StudyRequest) =>
      reply(
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
      ),
  );
  server.registerTool(
    'get_guidance',
    {
      title: 'Study guidance',
      description: `Returns the versioned study guidance: method, the guidance of each study task, how to use the study tool, and what data is offered. Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}, all.`,
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
