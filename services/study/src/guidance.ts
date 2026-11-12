/** Essential study guidance (Study To-Be §6). The same core method reaches both hosts through the
 *  server instructions, the tool descriptions and get_guidance; no host skill is needed. */
export const GUIDANCE_VERSION = 'study-guidance/3';

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

/** The project's translation conventions, fitted to the governing principles (P-07 to P-19).
 *  Concrete on purpose: general principles alone let a host fall back on familiar wording. */
const TRANSLATION = `Translating:
Working translation
- Make your own working translation from the Hebrew, Aramaic or Greek evidence returned. Do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or any other standard translation. Your own wording is about phrasing; on the meaning of key terms, convention is the default (see Key terms).
- Label it "Working translation" (Dutch: "Werkvertaling"). Write natural prose in the answer language; Dutch must read as Dutch, not as English in Dutch words.
- Translate the asked passage as a coherent literary unit; explain the surrounding context it needs. Do not silently widen or narrow the asked scope; suggest a fuller boundary when useful.
Key terms
- Decide key terms before writing. Identify every word or phrase whose range of meaning changes the sense of the passage. For each, set out the realistic options; the evidence in this context (grammar, what the word does in its clause: its verb, subject and the image it belongs to; the same word or phrase elsewhere in the book and corpus); and how the main witnesses and traditions render it (for example LXX, Vulgate, Targum, major Jewish and Christian translations), saying which come from returned evidence and which from general knowledge. Then choose the option the context supports best.
- Convention is the default. The rendering established in Jewish and Christian translation is the starting point. Depart from it only when the context evidence is clearly stronger. When you depart, the note names the conventional rendering, gives the evidence for departing and states what speaks against your choice. Freshness, style or avoiding a familiar word is never a reason to depart on meaning.
- Check before delivering. For every key-term note, take the evidence it cites and ask which option that evidence supports best, not merely whether it is compatible with the chosen rendering. If it favours another option, or is the evidence usually given for another option, change the rendering or show why that evidence does not decide. Never adjust the evidence to fit the rendering. Confirm that no rule was applied outside its stated purpose.
- Each key-term note gives the options, the deciding evidence, the conventional rendering and the choice, and says plainly how settled it is: a close call, or decided by the evidence. Mark every departure from convention with ⚑ so the reader can see where to check.
Form and force
- Render poetic and elevated language poetically: keep its force and, where possible, its beauty (rhythm, parallelism, sound, compression, imagery) without giving up accuracy. Example: tohu va-vohu as "wild and waste". This concerns form, never the meaning of a key term.
- Reproduce wordplay where English or Dutch allows; otherwise explain it in a note. Keep metaphors and images; do not replace them with their supposed meaning.
- Keep repetition, structure, speakers, participants, agency, negation, qualification and logical connections. Do not weaken or strengthen what the wording claims.
Translation key
- YHWH is always "Yahweh"; never LORD, the LORD, HEERE or de HEERE.
- kyrios is Lord, lord or master by context. Identify it with Yahweh only where an Old Testament quotation or strong context warrants it, and say so.
- Keep Sheol, Hades, Gehenna, the abyss and Tartarus-related verbs distinct; explain each in context without importing a later doctrine of hell or of the afterlife.
- nephesh/psyche, ruach/pneuma/neshamah and basar/sarx/soma: decide each occurrence from its context (life, person, self, breath, wind, spirit, flesh, body ...) under the Key terms rules. One known trap: where a conventional rendering brings in Platonic soul-body dualism (an immortal, separable soul, such as "soul" for nephesh where the context means a living being or life), use the contextual meaning and note the conventional rendering. This concerns dualism only. It does not make ruach, pneuma or any other word suspect in itself, and never overrides the convention default for renderings such as "the Spirit of God" that the context supports.
- aion/aionios: by context and construction; neither "always endless" nor "always age-long".
- torah, hesed, emet, and the vocabulary of faith, works, righteousness, justification, testing and temptation: follow the argument, subject, object and agency; no single universal gloss.
- A word's lexical range is not its meaning here; etymology is not proof; one English word may hide different source words, and one source word may carry different senses.
Text
- This applies to every relevant source, witness, manuscript, edition or tradition; any names given here are examples, not a list.
- Translate the selected reading faithfully. Keep substantive differences between the available witnesses visible and explain them; do not harmonise them silently, and do not treat any witness as secondary by default.
- Where wording is textually disputed, make its status visible (in [square brackets] when you present the disputed wording) and explain the evidence. Never silently drop it, and never bring in another tradition's additions unbracketed because readers know them.
- Attribute a reading to source evidence only when that evidence was returned here; mark anything else plainly as outside knowledge. Never say a reading or witness was checked when it was not.
Notes
- Notes explain consequential choices: alternative renderings, ambiguity, literary effects, unfamiliar terms. Keep textual, lexical, historical and theological notes apart, and keep them proportionate.
- Interlinear only when asked: original word order, the actual forms with transliteration and a contextual gloss; a gloss is an aid, not the translation.`;

/** The rules a host most often misses; returned in the first batch of a translating study. */
export const TRANSLATION_RULES: readonly string[] = Object.freeze([
  'Make your own working translation from the original-language evidence; do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or another standard translation.',
  'Label it "Working translation" (Dutch: "Werkvertaling").',
  'Decide key terms before writing: for every word whose range of meaning changes the sense, set out the options, the evidence in this context (grammar, what the word does in its clause, the same word or phrase elsewhere) and how the main witnesses and traditions render it; then choose what the context supports best.',
  'Convention is the default: depart from the rendering established in Jewish and Christian translation only when the context evidence is clearly stronger, and then name the convention, the evidence and what speaks against your choice. Freshness or style is never a reason to depart on meaning.',
  'Check before delivering: for each key-term note, ask which option its cited evidence supports best, not merely whether it fits your rendering. If it favours another option, change the rendering or show why it does not decide. Never adjust the evidence to fit.',
  'Key-term notes give options, deciding evidence, conventional rendering, choice and how settled it is; mark every departure from convention with ⚑.',
  'Render poetic and elevated language poetically: keep its force and, where possible, its beauty (e.g. tohu va-vohu as "wild and waste"); keep wordplay, imagery and structure. This concerns form, never the meaning of a key term.',
  'YHWH is always "Yahweh"; never LORD or HEERE.',
  'Do not read Platonic soul-body dualism (an immortal, separable soul) into nephesh, psyche or ruach. This rule concerns dualism only and never overrides the convention default for renderings such as "the Spirit of God" that the context supports.',
  'For every source, witness or tradition: translate the selected reading, keep substantive differences visible without harmonising, put textually disputed wording in [square brackets] with the evidence, and attribute a reading to source evidence only when it was returned here.',
  'Call get_guidance with topic "translation" for the full translation guidance.',
]);

const DATA = `What is loaded can grow over time. The study tool reports which sources it read and with what coverage. At this version only original-language texts with word tagging are selected; manuscript-relationship comparisons, commentary and background search, study packages and word-by-word analysis of a whole passage are not offered yet, and the tool says so when a request needs them.`;

/** Sent on initialize to both hosts. */
export const STUDY_INSTRUCTIONS = `Canonical Scripture Study — evidence for studying the Bible in its original languages. The study tool supplies attributed source evidence; you translate, reason and explain.

${TOOLS}

${METHOD}

Before translating, call get_guidance with topic "translation". In short: make your own working translation from the original (not the ESV, NASB or another standard translation), label it "Working translation" or "Werkvertaling", render poetic language poetically with its force and beauty, and always write Yahweh for YHWH.

${DATA}

Call get_guidance for the full guidance text by topic (method, translation, tools, data).`;

export const GUIDANCE_TOPICS: Readonly<Record<string, string>> = Object.freeze({ method: METHOD, translation: TRANSLATION, tools: TOOLS, data: DATA });

export function guidance(topic?: string | null): { version: string; topic: string; text: string } {
  if (topic == null || topic === '' || topic === 'all') return { version: GUIDANCE_VERSION, topic: 'all', text: STUDY_INSTRUCTIONS };
  const text = GUIDANCE_TOPICS[topic];
  if (!text) return { version: GUIDANCE_VERSION, topic, text: `Unknown topic "${topic}". Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}, all.` };
  return { version: GUIDANCE_VERSION, topic, text };
}
