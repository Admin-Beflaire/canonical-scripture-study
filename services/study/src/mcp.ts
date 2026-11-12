import { fromJsonSchema } from '@modelcontextprotocol/server';
import { platformServer } from '../../../packages/shared/src/platform.ts';
import { MODES, DEPTHS, study, type StudyRequest } from './coordinator.ts';
import { guidance, GUIDANCE_TOPICS, STUDY_INSTRUCTIONS } from './guidance.ts';
import type { StudyReadEnvironment } from './read/bindings.ts';

const text = (max: number) => ({ type: 'string', minLength: 1, maxLength: max });

export const STUDY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['mode'],
  properties: {
    mode: { enum: [...MODES], description: 'What the user wants: translation, passage, exegesis, comparison, word_analysis, word_study, theme, inspect_source or conclusion_check.' },
    question: { ...text(2000), description: "The user's question, for context. The tool does not interpret it." },
    references: { type: 'array', minItems: 1, maxItems: 4, items: text(80), description: 'Passages in the source numbering, e.g. "Gen 1:1-2:3", "Genesis 1", "Mt 5:3-12" (up to 3 chapters each).' },
    search_leads: { type: 'array', minItems: 1, maxItems: 1, description: 'One search per call.', items: { type: 'object', additionalProperties: false, required: ['lookup', 'key'], properties: {
      lookup: { enum: ['word', 'form', 'lemma', 'grammar', 'phrase', 'proximity', 'fuzzy'] }, key: text(256) } } },
    sources: { type: 'array', minItems: 1, maxItems: 20, items: text(200), description: 'Limit to these source revision IDs (as returned in evidence). Default: every selected source.' },
    depth: { enum: [...DEPTHS], description: 'Breadth of evidence, not answer length. focused leaves out the surrounding chapter. Default standard.' },
    language: { ...text(35), description: 'Answer language for the user (default en). Evidence stays in the original.' },
    requested_result: { ...text(500), description: 'What the user wants delivered, for example a full translation with notes.' },
    interactive: { type: 'boolean', description: 'True only if the user asked to go step by step.' },
    continuation: { type: 'string', maxLength: 2048, description: 'Pass the continuation from the previous batch, with the same other arguments.' },
  },
} as const;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const reply = (data: unknown) => {
  const isError = !!data && typeof data === 'object' && Array.isArray((data as { evidence?: unknown }).evidence)
    && (data as { evidence: unknown[] }).evidence.length === 0 && (data as { release_id?: unknown }).release_id === undefined;
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], ...(isError ? { isError: true } : {}) };
};

/** The Study MCP server for one authenticated request: two read-only tools and their guidance. */
export function studyServer(env: StudyReadEnvironment, enhancements: boolean) {
  const server = platformServer('study', enhancements, STUDY_INSTRUCTIONS);
  server.registerTool('study', {
    title: 'Study Scripture evidence',
    description: 'Returns one bounded batch of attributed original-language evidence for a study: passages by reference, or exact word, form, lemma or grammar occurrences. Read-only. If the result has a continuation, call again with the same arguments plus the continuation until none is returned, then deliver the complete study. Limitations say what was not searched, loaded or read. Before translating, follow translation_rules in the result and get_guidance topic "translation": your own working translation from the original, not a standard translation.',
    inputSchema: fromJsonSchema<StudyRequest>(STUDY_SCHEMA as unknown as Record<string, unknown>),
    annotations: readOnly,
  }, async (request: StudyRequest) => reply(await study(env, request)));
  server.registerTool('get_guidance', {
    title: 'Study guidance',
    description: `Returns the versioned study guidance: method, how to use the study tool, and what data is offered. Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}, all.`,
    inputSchema: fromJsonSchema<{ topic?: string }>({ type: 'object', additionalProperties: false, properties: { topic: { enum: [...Object.keys(GUIDANCE_TOPICS), 'all'] } } }),
    annotations: readOnly,
  }, async ({ topic }: { topic?: string }) => ({ content: [{ type: 'text' as const, text: JSON.stringify(guidance(topic)) }] }));
  return server;
}
