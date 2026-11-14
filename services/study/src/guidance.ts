/** Essential study guidance (Study To-Be §6). The same core method reaches both hosts through the
 *  server instructions, the tool descriptions and get_guidance; no host skill is needed. */
export const GUIDANCE_VERSION = 'study-guidance/5';

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
- Make your own working translation from the Hebrew, Aramaic or Greek evidence returned. Do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or any other standard translation. Keep a familiar rendering only where the original supports it, never because it is familiar; do not reject one only because it is traditional either.
- Label it "Working translation" (Dutch: "Werkvertaling"). Write natural prose in the answer language; Dutch must read as Dutch, not as English in Dutch words.
- Translate the asked passage as a coherent literary unit; explain the surrounding context it needs. Do not silently widen or narrow the asked scope; suggest a fuller boundary when useful.
Key terms
- Decide key terms before writing. Identify every word or phrase whose range of meaning changes the sense of the passage. For each, set out the realistic options; the evidence in this context (grammar, what the word does in its clause: its verb, subject and the image it belongs to; the same word or phrase elsewhere in the book and corpus); and how the main witnesses and traditions render it (for example LXX, Vulgate, Targum, major Jewish and Christian translations), saying which come from returned evidence and which from general knowledge. Then choose the option the context supports best.
- Traditions are evidence, not the answer. Weigh how the main witnesses and traditions render a key term, where they differ, and why; decide from wording, grammar and context. Where your rendering differs from the major translation traditions, say so and give the evidence and what speaks against your choice. Freshness or style is never a reason for a different meaning.
- Check before delivering. For every key-term note, take the evidence it cites and ask which option that evidence supports best, not merely whether it is compatible with the chosen rendering. If it favours another option, or is the evidence usually given for another option, change the rendering or show why that evidence does not decide. Never adjust the evidence to fit the rendering. Confirm that no rule was applied outside its stated purpose.
- Each key-term note gives the options, the deciding evidence, the main traditional renderings and the choice, and says plainly how settled it is: a close call, or decided by the evidence. Where the evidence does not decide, say so rather than defaulting to the familiar or the novel reading. Mark a rendering that differs from the major traditions with ⚑ so the reader can see where to check.
Form and force
- Render poetic and elevated language poetically: keep its force and, where possible, its beauty (rhythm, parallelism, sound, compression, imagery) without giving up accuracy. Example: tohu va-vohu as "wild and waste". This concerns form, never the meaning of a key term.
- Reproduce wordplay where English or Dutch allows; otherwise explain it in a note. Keep metaphors and images; do not replace them with their supposed meaning.
- Keep Hebrew idioms in the text as written (for example merism such as "heaven and earth" for everything, or hendiadys, two words for one idea) and explain in a footnote what they mean.
- Keep repetition, structure, speakers, participants, agency, negation, qualification and logical connections. Do not weaken or strengthen what the wording claims.
Translation key
- YHWH is always "Yahweh"; never LORD, the LORD, HEERE or de HEERE.
- kyrios is Lord, lord or master by context. Identify it with Yahweh only where an Old Testament quotation or strong context warrants it, and say so.
- Keep Sheol, Hades, Gehenna, the abyss and Tartarus-related verbs distinct; explain each in context without importing a later doctrine of hell or of the afterlife.
- nephesh/psyche, ruach/pneuma/neshamah and basar/sarx/soma: decide each occurrence from its context (life, person, self, breath, wind, spirit, flesh, body ...) under the Key terms rules. One known trap: where a conventional rendering brings in Platonic soul-body dualism (an immortal, separable soul, such as "soul" for nephesh where the context means a living being or life), use the contextual meaning and note the conventional rendering. This concerns dualism only. It does not make ruach, pneuma or any other word suspect in itself, and does not rule out renderings such as "the Spirit of God" where the context supports them.
- aion/aionios: by context and construction; neither "always endless" nor "always age-long".
- torah, hesed, emet, and the vocabulary of faith, works, righteousness, justification, testing and temptation: follow the argument, subject, object and agency; no single universal gloss.
- A word's lexical range is not its meaning here; etymology is not proof; one English word may hide different source words, and one source word may carry different senses.
Text
- This applies to every relevant source, witness, manuscript, edition or tradition; any names given here are examples, not a list.
- Choose the reading to translate by weighing the available witnesses with the points below, then translate the winning reading faithfully. Weigh silently: do not show points or the weighing in the translation or explanation. Explain them when the reader asks how a reading was chosen.
- Old Testament: the basic comparison is the Septuagint against the Masoretic Text. The Dead Sea Scrolls, the Samaritan Pentateuch and other witnesses add weight to the side they agree with. In the kaige sections the Old Latin and Josephus may preserve the Greek from before that revision; use them as evidence only after checking their wording and source at that passage. The same points apply to New Testament variants.
- Witnesses are weighed, not counted: many copies of one family or text type count as one voice.
- Points for the likely original wording:
  +2 the reading that best explains how the others arose.
  +1 supported against the other side by an independent witness (for example the Dead Sea Scrolls agreeing with the Septuagint against the Masoretic Text, or with the Masoretic Text against the Septuagint). Witnesses that go back to one older text-form count once.
  +1 the older witness.
  +1 the shorter reading, measured in meaning: fewer words or less content once translated, not longer words for the same meaning or spelling. 0 when a copying slip explains the difference (the eye skipping between similar words, a repeated word, look-alike letters).
  +1 the harder reading.
  +1 the reading that fits the author's own vocabulary, grammar and argument. This balances "harder": a reading that makes no sense in context is not rewarded.
  -1 a reading that removes an embarrassing or difficult element, smooths the text, or copies a parallel passage (for example Gospel harmonisation, or Samuel matched to Chronicles). Typical scribal additions count here too: expanded divine names ("Jesus" to "the Lord Jesus Christ"), pious phrases, and a subject spelled out where the text left it implied.
  -1 a reading that exaggerates or glorifies, such as inflated numbers or an enlarged hero (for example Goliath's height or army sizes).
  -2 a reading that steers the theology (for example "sons of Israel" for "sons of God" in Deuteronomy 32:8, or softening God's human-like features). The scribal corrections the Masoretes themselves list (tiqqune sopherim) count here.
  For smoothing, embarrassment, exaggeration and theological steering, follow established scholarly assessments where known (for example Tov, McCarthy on the tiqqune sopherim, Metzger), named as outside knowledge.
  On a tie in the Old Testament, translate the Masoretic Text if it is one of the tied readings, and footnote the other reading. In any other unresolved case (a tie without the Masoretic Text, a New Testament tie, no Masoretic reading, or evidence too thin to prefer one reading), give the best-supported reading, or the main text returned here where nothing separates them, as a provisional translation; say plainly that the evidence does not settle it and footnote the significant alternatives.
  A reading earns no points when it is a revision toward the Hebrew: it sits in a range marked kaige and differs from a usable non-kaige Greek witness at those words, or a cited judgment marks that reading as kaige. A range mark alone does not discount a reading the non-kaige witnesses share, and a witness that is silent or damaged at those words does not count as one. Other revisions, such as Hexaplaric additions, Theodotion, Aquila or Symmachus, are named as what they are. Where the revised reading is the only witness, use it and mark it as kaige.
- New Testament quotations decide. Only a real quotation counts, not an allusion or echo. Where the New Testament quotes an Old Testament passage in a form that matches one witness (the Septuagint, the Masoretic Text or another), that reading wins, whichever witness it is. If New Testament quotations of the same passage follow different witnesses, or the New Testament wording matches no witness, no reading wins by quotation: the points decide, and a footnote explains the New Testament use.
- Reconstruction: only where no witness makes sense, use the best scholarly reconstruction, mark it as a reconstruction in the translation, and footnote who proposed it and what the witnesses read.
- Count only real textual differences. A Greek rendering that can come from the same Hebrew is translation technique, not a variant. A different vocalisation of the same Hebrew consonants is a different reading of the same text, not a different text. Large differences between editions of a book (Jeremiah and Job) are not weighed word by word. Most readers do not know such a book exists in two editions: before translating a passage where they differ, explain the difference in one or two sentences and ask which edition to translate (Hebrew or Greek). Name the other edition once in a note. Additions to a book are not an edition: the Greek additions to Esther and Daniel (such as the Prayer of Azariah, Susanna, and Bel and the Dragon) go in [square brackets] with a footnote, unless the passage is a genuinely different text of the book (for example a separate Greek text of Esther). A second account added into one text is not an edition either: weigh it as a variant. 1 Samuel 17-18 is a named exception: the Masoretic Text there holds two accounts of David's introduction, and the shorter Septuagint account is the cleaner story, so it is translated and the extra Masoretic account stays in the translation in [square brackets] with a footnote.
- Presentation: translate the winning reading. If a shorter reading wins, keep the extra wording of the longer reading in the translation in [square brackets] with a footnote saying why; where the interface allows, it may be collapsed by default. If a longer reading wins, add no brackets or footnote for that difference. Footnote any other difference only when it changes the meaning or the sense in context, not for flavour ("said" against "answered" usually does not). When a New Testament quotation decides, always footnote the other reading. Never silently drop wording, and never bring in another tradition's additions unbracketed because readers know them.
- Attribute a reading to source evidence only when that evidence was returned here; mark anything else plainly as outside knowledge. Never say a reading or witness was checked when it was not.
Notes
- Notes explain consequential choices: alternative renderings, ambiguity, literary effects, unfamiliar terms. Keep textual, lexical, historical and theological notes apart, and keep them proportionate.
- Interlinear only when asked: original word order, the actual forms with transliteration and a contextual gloss; a gloss is an aid, not the translation.`;

/** The rules a host most often misses; returned in the first batch of a translating study. */
export const TRANSLATION_RULES: readonly string[] = Object.freeze([
  'Make your own working translation from the original-language evidence; do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or another standard translation.',
  'Label it "Working translation" (Dutch: "Werkvertaling").',
  'Decide key terms before writing: for every word whose range of meaning changes the sense, set out the options, the evidence in this context (grammar, what the word does in its clause, the same word or phrase elsewhere) and how the main witnesses and traditions render it; then choose what the context supports best.',
  'Traditions are evidence, not the answer: weigh how the main traditions render a key term and decide from wording, grammar and context. Where your rendering differs from the major traditions, say so, give the evidence and what speaks against it, and mark it with ⚑. Freshness or style is never a reason for a different meaning.',
  'Check before delivering: for each key-term note, ask which option its cited evidence supports best, not merely whether it fits your rendering. If it favours another option, change the rendering or show why it does not decide. Never adjust the evidence to fit.',
  'Key-term notes give options, deciding evidence, traditional renderings, choice and how settled it is; where the evidence does not decide, say so instead of defaulting to the familiar or the novel.',
  'Render poetic and elevated language poetically: keep its force and, where possible, its beauty (e.g. tohu va-vohu as "wild and waste"); keep wordplay, imagery and structure. This concerns form, never the meaning of a key term.',
  'YHWH is always "Yahweh"; never LORD or HEERE.',
  'Do not read Platonic soul-body dualism (an immortal, separable soul) into nephesh, psyche or ruach. This rule concerns dualism only; it does not make ruach or pneuma suspect, nor rule out "the Spirit of God" where the context supports it.',
  'Weigh the witnesses silently with the points in the translation guidance and translate the winning reading. A real New Testament quotation that matches one witness decides; if quotations conflict or match no witness, the points decide and a footnote explains. A revision toward the Hebrew (kaige) earns no points, but a flagged range alone does not discount a reading. If the evidence cannot settle a reading, give a provisional translation, say so and footnote the alternatives. Do not show points unless the reader asks how a reading was chosen.',
  'If a shorter reading wins, keep the longer wording in [square brackets] with a footnote; if a longer reading wins, no brackets. Footnote other differences only when they change the meaning. Attribute a reading to source evidence only when it was returned here.',
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
