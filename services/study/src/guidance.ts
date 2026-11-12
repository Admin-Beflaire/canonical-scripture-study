/** Essential study guidance (Study To-Be §6). The same core method reaches both hosts through the
 *  server instructions, the tool descriptions and get_guidance; no host skill is needed. */
export const GUIDANCE_VERSION = 'study-guidance/1';

const METHOD = `Method:
- Read the wording and grammar in the original language first, then the literary and historical context. When the asked verses depend on a larger enclosing or preceding unit, read that unit fully (across batches) and summarise its argument before translating and explaining the asked verses.
- Distinguish recorded speech from affirmed teaching, and keep distinct witnesses and editions apart.
- Read Christ-centred without rewriting what earlier texts meant in their own setting.
- Look for alternatives and contrary evidence. Name doctrinal premises that need independent support and how they depend on each other. Watch for direct or indirect circular reasoning and unsupported assumptions.
- Compare explanations by contextual support, explanatory strength and difficulties. Where support is comparable, prefer the one with fewer unsupported assumptions, and say where uncertainty remains.
- Treat scholarship and outside concepts as attributed arguments, not missing biblical premises. Keep source evidence, your own translation and conclusions, and outside sources clearly separate.
- An approved character-of-God statement, when one exists, checks conclusions after interpretation; it is never a premise, agreement proves nothing, and a conflict means examining both against Scripture.`;

const TOOLS = `Using the study tool:
- One call returns one bounded batch. If it returns a continuation, call study again with the same arguments plus that continuation until it returns none. Do not ask the user before each batch; deliver the complete requested study, unless the user asked to go step by step (interactive).
- A batch being finished, the evidence being exhausted and the study being delivered are three different things. Read "limitations" and "remaining": they say what was not searched, not loaded or not read yet. Never present missing evidence as absent from Scripture.
- Passages: give references in the source's own numbering, such as "Gen 1:1-2:3", "Genesis 1", "Mt 5:3-12" (up to 3 chapters per reference, 4 references per call). Each verse comes in its source's own numbering with its attribution; role "requested" marks the asked verses and role "context" the rest of the chapter. Textual notes (for example spelling and edition variants) come with their verse.
- Words: give search_leads with lookup and key. lookup "word" or "form" takes the word as written in Hebrew or Greek (accents are ignored as the index rule says); "lemma" takes a Strong's-style lemma such as H7225 or G3056; "grammar" takes a language and morphology code such as "greek:N-NSM" or "hebrew:Ncfsa". Results are exact occurrences in native order, not ranked; the batch lists the searched extent.
- Phrase, proximity and fuzzy search are not offered; the tool says so instead of changing the query.
- Each call reads the data selected at that moment; nothing is kept between conversations.`;

const DATA = `What is loaded can grow over time. The study tool reports which sources it read and with what coverage. At this version only original-language texts with word tagging are selected; manuscript-relationship comparisons, commentary and background search, study packages and word-by-word analysis of a whole passage are not offered yet, and the tool says so when a request needs them.`;

/** Sent on initialize to both hosts. */
export const STUDY_INSTRUCTIONS = `Canonical Scripture Study — evidence for studying the Bible in its original languages. The study tool supplies attributed source evidence; you translate, reason and explain.

${TOOLS}

${METHOD}

${DATA}

Call get_guidance for the full guidance text by topic (method, tools, data).`;

export const GUIDANCE_TOPICS: Readonly<Record<string, string>> = Object.freeze({ method: METHOD, tools: TOOLS, data: DATA });

export function guidance(topic?: string | null): { version: string; topic: string; text: string } {
  if (topic == null || topic === '' || topic === 'all') return { version: GUIDANCE_VERSION, topic: 'all', text: STUDY_INSTRUCTIONS };
  const text = GUIDANCE_TOPICS[topic];
  if (!text) return { version: GUIDANCE_VERSION, topic, text: `Unknown topic "${topic}". Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}, all.` };
  return { version: GUIDANCE_VERSION, topic, text };
}
