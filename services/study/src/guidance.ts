import type {TaskSkill} from '../../../packages/shared/src/skills.ts';
import type {Mode} from './coordinator.ts';
import {
  COMPARISON,
  CONCLUSION_CHECK,
  EXEGESIS,
  SOURCE_INSPECTION,
  THEME,
  TRANSLATION_KEY,
  WITNESS_POINTS,
  WORD_STUDY,
} from './task-guidance.ts';
import {presentation} from './presentation.ts';

/** Essential study guidance (Study To-Be §6). Every study goes through the skill of its mode: the
 *  whole way of working for that kind of question. A host loads it as a skill or reads the same
 *  text with get_guidance, and passes the code it ends with in every study call. The
 *  instructions only lead there. Every rule on using the study tool is complete in the tool's
 *  or a field's description. */
export const GUIDANCE_VERSION = 'study-guidance/29';

const METHOD = `Method:
- Read the wording and grammar in the original language first, then the literary and historical context. When the asked verses depend on a larger enclosing or preceding unit, read that unit fully (across batches) at every detail level. In a translation, give its argument in one or two sentences before the translation at standard and full, and do not write it at concise. In other study requests, summarise its argument before explaining the asked verses.
- Distinguish recorded speech from affirmed teaching, and keep distinct witnesses and editions apart.
- Read Christ-centred without rewriting what earlier texts meant in their own setting.
- Look for alternatives and contrary evidence. Name doctrinal premises that need independent support and how they depend on each other. Watch for direct or indirect circular reasoning and unsupported assumptions.
- Compare explanations by contextual support, explanatory strength and difficulties. Where support is comparable, prefer the one with fewer unsupported assumptions, and say where uncertainty remains.
- Treat scholarship and outside concepts as attributed arguments, not missing biblical premises. Keep source evidence, your own translation and conclusions, and outside sources clearly separate.
- God's character is the light in which you work out your own explanation of what Scripture means, from the start, and the test for every explanation and for every theological conclusion of your finished answer. The conclusion-check skill gives the approved statement of it, when one exists: it never decides a translation, it is never a premise, agreement proves nothing, and a conflict means examining both against Scripture.`;

/** How to use the study tool, one rule each; they travel with the tool and field descriptions. */
export const SUPERSCRIPTION_RULE =
  'Present a source-authored superscription unnumbered and in italics above verse 1, separately from numbered text.';
const STEP_BY_STEP = 'unless the user asked to go step by step (interactive)';
export const CONTINUATION = `One call returns one bounded batch. If it returns a continuation, call study again with the same arguments plus that continuation until it returns none. Do not ask the user before each batch; deliver the complete requested study, ${STEP_BY_STEP}.`;
export const ABSENCE_RULE =
  'Never present missing evidence as absent from Scripture.';
export const COVERAGE = `A batch being finished, the evidence being exhausted and the study being delivered are three different things. Read "limitations" and "remaining": they say what was not searched, not loaded or not read yet. ${ABSENCE_RULE}`;
export const NUMBERING = `When delivered_scope.numbering_notes is present, explain those numbering differences to the reader with the answer.`;
export const PASSAGES = `Passages: give NRSVA reader references such as "Mal 4:1-6" (up to 3 chapters per reference, 4 references per call). Checked mappings supply the reader reference alongside attributed native citations; missing mappings are limitations, never assumed equivalences. Without a mapping, show the verse by its native numbering and say that any native candidate the study returns is unverified, not a checked match. Only when exact native text is still needed, inspect native numbering with mode "inspect_source" and exactly one source revision in sources. ${SUPERSCRIPTION_RULE} Role "requested" marks asked verses and "context" the surrounding chapter. Textual notes come with their verse.`;
export const WORD_LOOKUPS = `Words: give search_leads with lookup and key. lookup "word" or "form" takes the word as written in Hebrew or Greek (accents are ignored as the index rule says); "lemma" takes a Strong's-style lemma such as H7225 or G3056; "grammar" takes a language and morphology code such as "greek:N-NSM" or "hebrew:Ncfsa". Results are exact occurrences in native order, not ranked; the batch lists the searched extent. When a routing_summary is marked, it reports selected index coverage proven to contain no matches for the key without opening those R2 pages, not a direct reading of those pages.`;
export const WORD_FOCUS = `For a word study, focus optionally moves lexicon, grammar, names or occurrences to the front. Use names for a person question, grammar for a morphology question and occurrences for an enumeration. Follow linked-aid continuations before deciding what evidence is available.`;
export const PROPER_NAMES = `TIPNR proper-name candidates: use lookup "proper_name" with the complete disambiguated Strong tag (for example G2264G). A word study delivers candidates and exact full-tag occurrences. In continued word searches, delivered_scope.linked_aid identifies the lookup and key of separately delivered evidence. Check each entry’s references, ambiguity link when present, and source before associating it with a specific occurrence. TIPNR OTHER categories and records without a named form are not prepared. Different identities and alternative name forms remain separate.`;
export const LANGUAGE_AIDS = `Language aids: use lookup "lexicon" with a Strong number (e.g. H7307 or G3686), "grammar_info" with an exact source morphology code, and "lexicon_entry" with an exact entry key. For a compound Hebrew morphology code, split the components and use the H or A language prefix on each, for example HR/Ncfsa becomes HR and HNcfsa. For Greek compound codes, look up each source component separately. Word-search hits may include aid_matches per analysis, pointing to the attributed language_aid evidence returned with the hits. Across batches match separately delivered entries by lookup and key. Keep distinct entries and source attribution. An Open Scriptures index entry can provide linked_entry_keys: look up each with "lexicon_entry" to read the BDB articles. A gloss is not a full definition; missing entries and transcription limitations remain gaps. When delivery_part is present, join the ordered parts of that entry; obtain all continuations.`;
export const NOT_OFFERED = `Phrase, proximity and fuzzy search are not offered; the tool says so instead of changing the query.`;
export const SELECTED_DATA = `Each call reads the data selected at that moment; nothing is kept between conversations.`;
export const SKILL_CODE =
  'Required on every call, continuations included: the code at the end of the skill for the mode. Read that skill first, as a skill or with get_guidance and its name as topic.';

const bullets = (...rules: string[]) =>
  rules.map(rule => `- ${rule}`).join('\n');

/** The project's translation conventions, fitted to the governing principles (P-07 to P-19).
 *  Concrete on purpose: general principles alone let a host fall back on familiar wording. */
const TRANSLATION = `Translating:

How this guidance is organised
- Part 1 is reading and deciding: the work before you write. The research is the same at every note level.
- Part 2 is the answer: what you write, as a skeleton per level. Only the note level controls it.
- The aim is to teach the reader which choices were made and why. Wording may differ between runs and levels; every real choice is visible, with its reason.
- Where a rule in Part 1 says to footnote, note, explain or say something in the answer, it also names a decision you must make. Always make the decision. Part 2 says whether and how it appears at the level.

Part 1. Read and decide (the same at every level)

Scope
- Asked scope means what the reader named, read as follows. A request for a passage or a chapter covers the complete literary unit it belongs to (for example Genesis 1 is Genesis 1:1 to 2:3). A request for particular verses covers exactly those verses. The surrounding context is always read, but only the asked scope is delivered.
- The title of the answer states the boundary actually translated (Part 2). Suggest a fuller or narrower one when useful. "Silently" means without saying.
- Translate the asked passage as a coherent literary unit; read the surrounding context it needs. Part 2 says whether that context is explained. Do not silently widen or narrow the asked scope; suggest a fuller boundary when useful. When no unit boundary is available, read the adjacent context that is available and report that uncertainty (Part 2 says where).
Evidence
- Call study again with each continuation until none is returned, and read the limitations and remaining fields. Do this, and read the enclosing unit the translation needs, at every level.
- When the asked verses depend on a larger enclosing or preceding unit, read that unit fully (across batches) at every detail level and use its argument to decide the translation. Then give its argument in one or two sentences before the translation at standard and full; at concise do not write it (Part 2).
- The research needed to decide a translation choice is the same at every level. A level never removes it.
- Make outside lookups only for a question that needs one. Explain only sources you consulted.
- When the study tool returns no text of a witness (for example the Septuagint (LXX), the Dead Sea Scrolls, the Samaritan Pentateuch, a Targum, the Vulgate or New Testament manuscripts) and the passage has a quotation of other Scripture or a textual difference, use your own knowledge of that witness to flag where it is known to differ and what it reads. It only flags: it never decides which reading is translated and earns no points; the reading follows the evidence the tool returned. Keep it out of every translation decision: reading choice, matching a New Testament quotation to a witness, and weighing key terms. Mark it "(outside knowledge, unchecked)". If you know of no difference, say nothing; never invent one. Unverified testimony about a witness (for example a Dead Sea Scrolls manuscript) is a lead to flag in the same way, never evidence, unless you cite checked evidence. At concise, put it in the "Limits:" line as a brief fragment instead of a footnote.
- Name what the evidence is. A flag such as a TAGNT edition list shows which editions carry a reading; it is not manuscript evidence, and edition names do not show that witnesses are independent or dependent. Treat witnesses as one voice only where the evidence shows they go back to one text-form. Where only one source is returned or the evidence ties, call the reading provisional and say in a few words what it rests on (for example "edition flags only"); do not invent a winning case.
- When a passage quotes other Scripture, or an Old Testament passage is quoted in the New Testament, read the quoted passages and the quoting passages: before awarding quotation priority or calling a witness match decisive, read the actual quotation and the candidate source wording, whichever passage the reader asked to translate. Limit this to relevant direct quotations and plausible source passages, read within available coverage with the same Study tool calls at every level; no broad cross-reference search is needed. Label the exact returned evidence, the candidate links and what remains unresolved, and say apart whether a comparison that could be made found no match, or could not be finished because a witness is missing. Where two or more passages are plausible sources (for example 2 Samuel 7:14 and 1 Chronicles 17:13 behind Hebrews 1:5), name them all.
- When a checked reader mapping is missing, use any native candidates the study result returns and say they are unverified native candidates, not checked matches. Only when exact native text is still needed and the native reference is known, inspect the source by its native numbering, as the source-inspection skill describes, and say that the text was read by native numbering and not by a checked mapping.
- First retrieve the current project's relevant lexical entries and their continuations; use them whenever available. If the returned entries or limitations show that relevant evidence is missing or insufficient, for a specific translation question consult only these agreed external websites as needed: STEP Bible (https://www.stepbible.org/), Logeion (https://logeion.uchicago.edu/), and Open Scriptures Hebrew Lexicon (https://github.com/openscriptures/HebrewLexicon). Keep outside research focused; do not claim to have consulted an inaccessible resource. Name the consulted resource and explain its relevant sense in your own words; do not reproduce its entry text. A lexicon gives possible senses, not a decision apart from context. The separate exegesis source list is not defined here.
Working translation
- Make your own working translation from the Hebrew, Aramaic or Greek evidence returned. Do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or any other standard translation. Keep a familiar rendering only where the original supports it, never because it is familiar; do not reject one only because it is traditional either.
- Label it "Working translation" (Dutch: "Werkvertaling"), with the reference in the title (Part 2). Write natural prose in the answer language; Dutch must read as Dutch, not as English in Dutch words.
- Supplied words: set in italics each word in the answer language that has no source word, inflection or construction behind it, including "is" or "are" in a verbless clause. Do not italicize a word that only renders an inflection or construction ("he said" from one verb, "will", "of" for a genitive). The same distinction applies in Dutch. Inside a small-cap quotation, supplied words are italic small caps.
- Before presenting the translation, reason through consequential lexical, grammatical and textual choices from the evidence and their context. Ensure the chosen rendering follows from the evidence and reasons given; where the evidence does not decide, acknowledge the uncertainty. Do not import a wider theological conclusion into the translation.
Key terms
- Decide key terms before writing. Identify every word or phrase whose range of meaning changes the sense of the passage. For each, set out the realistic options; the evidence in this context (grammar, what the word does in its clause: its verb, subject and the image it belongs to; the same word or phrase elsewhere in the book and corpus); and how the main witnesses and traditions render it (for example LXX, Vulgate, Targum, major Jewish and Christian translations), saying which come from returned evidence and which from general knowledge. Then choose the option the context supports best.
- Traditions are evidence, not the answer. Weigh how the main witnesses and traditions render a key term, where they differ, and why; decide from wording, grammar and context. Where your rendering differs from the major translation traditions, say so and give the evidence and what speaks against your choice. Freshness or style is never a reason for a different meaning. Where traditions differ, report it and mark what was returned and what is outside knowledge. Returned or checked renderings inform the weighing; renderings marked outside knowledge stay labelled flags and never enter the weighing or decide it.
- Check before delivering. For every key-term note, take the evidence it cites and ask which option that evidence supports best, not merely whether it is compatible with the chosen rendering. If it favours another option, or is the evidence usually given for another option, change the rendering or show why that evidence does not decide. Never adjust the evidence to fit the rendering. Confirm that no rule was applied outside its stated purpose.
- Each key-term note gives the options, the deciding evidence, the main traditional renderings and the choice, and states the basis of the choice in one clause: "The context decides: …", "The evidence favours X: …" or "The evidence does not decide; X is followed because …", never defaulting to the familiar or the novel reading, and never with "close call" or the first person. Mark a rendering that differs from the major traditions with ⚑ so the reader can see where to check.
Text
- This applies to every relevant source, witness, manuscript, edition or tradition; any names given here are examples, not a list.
- Choose the reading to translate by weighing the available witnesses with the points below, then translate the winning reading faithfully. Explain the evidence and reasoning as a narrative; do not show scores, points or checks unless the reader asks how a reading was chosen; then show the points that decided it.
- Old Testament: the basic comparison is the Septuagint against the Masoretic Text. The Dead Sea Scrolls, the Samaritan Pentateuch and other witnesses add weight to the side they agree with. In the kaige sections the Old Latin and Josephus may preserve the Greek from before that revision; use them as evidence only after checking their wording and source at that passage. The same points apply to New Testament variants.
${WITNESS_POINTS}
- Reconstruction: only where no witness makes sense, use the best scholarly reconstruction, mark it as a reconstruction in the translation, and footnote who proposed it and what the witnesses read.
- Count only real textual differences. A Greek rendering that can come from the same Hebrew is translation technique, not a variant. A different vocalisation of the same Hebrew consonants is a different reading of the same text, not a different text. Longer text that does not win goes in [square brackets] with a footnote, whatever its kind or length, in the Old and the New Testament: a long extra story or account (1 Samuel 17-18), a Greek addition (the Prayer of Azariah, Susanna, Bel and the Dragon, the added parts of Esther) or a single added line (the ending of the Lord's Prayer in Matthew 6:13). Only when the difference is too large to bracket, as with the two editions of Jeremiah and Job, do not weigh word by word: most readers do not know such a book exists in two editions, so before translating a passage where they differ, explain the difference in one or two sentences and ask which edition to translate (Hebrew or Greek), and name the other edition once in a note.
Footnote triggers (which choices get a footnote at standard and full; Part 2 says how)
- Each of these gets one footnote, and notes on the same word or overlapping phrases merge: a key term with real options; a quotation of other Scripture (name every plausible source passage and say which witness it follows, or that this is unresolved); a [bracketed] passage or a textual difference that changes the meaning; a rendering marked ⚑; an idiom, wordplay or reconstruction. Straightforward wording gets none.
- Presentation of textual differences: translate the winning reading. If a shorter reading wins, keep the extra wording of the longer reading in the translation in [square brackets] with a footnote saying why; where the interface allows, it may be collapsed by default. If a longer reading wins, do not bracket it; footnote a consequential difference and explain the choice. Footnote differences that change the meaning or the sense in context, not merely flavour ("said" against "answered" usually does not). When a New Testament quotation decides, always footnote the other reading. Never silently drop wording, and never bring in another tradition's additions unbracketed because readers know them.
Form and force
- Render poetic and elevated language poetically: keep its force and, where possible, its beauty (rhythm, parallelism, sound, compression, imagery) without giving up accuracy. Example: tohu va-vohu as "wild and waste". This concerns form, never the meaning of a key term.
- Reproduce wordplay where English or Dutch allows; otherwise explain it in a note. Keep metaphors and images; do not replace them with their supposed meaning.
- Keep Hebrew idioms in the text as written (for example merism such as "heaven and earth" for everything, or hendiadys, two words for one idea) and explain in a footnote what they mean.
- Keep repetition, structure, speakers, participants, agency, negation, qualification and logical connections. Do not weaken or strengthen what the wording claims.
Translation key
${TRANSLATION_KEY}
- Interlinear only when asked: original word order, the actual forms with transliteration and a contextual gloss; a gloss is an aid, not the translation.`;

/** The translation rules a host most often misses; the skills of other studies that include a
 *  translation carry them. */
export const TRANSLATION_RULES: readonly string[] = Object.freeze([
  'Make your own working translation from the original-language evidence; do not reproduce or lightly adapt the ESV, NASB, NIV, KJV, Statenvertaling, NBV or another standard translation. Title it "Working translation — <reference>" (Dutch: "Werkvertaling — <referentie>"): the reference is the unit actually translated, said once, with no level name.',
  'YHWH is always "Yahweh"; never LORD or HEERE.',
  'Follow the asked scope: a passage or chapter covers the complete literary unit it belongs to; particular verses cover exactly those verses. The title states the boundary used. When the translation covers more than one chapter, put a chapter heading (book and chapter only) before the first verse of each chapter, including the first; verse numbers restart in each chapter. An optional section heading describes the content, carries no scripture reference and goes between the chapter heading and the first verse.',
  'Decide key terms and the winning reading from the evidence before writing; traditions are evidence, not the answer; mark a departure from the major traditions with ⚑. State the basis of each choice in one clause ("The context decides: …", "The evidence favours X: …", "The evidence does not decide; X is followed because …").',
  'Set the note level first (concise, standard, full; default standard). The level changes only the notes and the unit argument. At every level make the same Study tool calls, follow every continuation, read the same evidence and do the research needed to decide a choice. Wording may differ between runs and levels; teach the reader which choices were made and why. Write the answer as normal markdown that follows the skeleton for the level.',
  'Concise: no footnotes and no explanation, except the Concise exceptions: a question asked before translating, a one-line correction disclosure, and the marks in the translation ([square brackets], a reconstruction, ⚑). Longer wording that lost stays in [square brackets] without a footnote; a one-line Sources line with the required attribution. At every level, a one-line "Limits:" line for material limitations: witnesses not returned, incomplete retrieval or coverage, a provisional or unresolved reading or source, a tie or reconstruction, a departure from the major traditions on a key term, unverified native numbering or unit boundary. The line stays short: each limitation in a few words, no explanation, no "I".',
  'Footnotes (standard and full): under the heading "Footnotes" (Dutch: "Voetnoten"), at the same heading level as the title. Each footnote follows the slots of its trigger: a key term or ⚑ rendering (the word in its own script with a transliteration, its range of senses, the context, the choice with its basis); a quotation of other Scripture (the sources named, the wording compared, which witness it follows or "unresolved"); a textual difference or bracketed passage (the readings, which editions or witnesses carry each, why one wins or that the evidence does not decide); an idiom, wordplay or reconstruction. A note that only lists an alternative is not enough. A note is about the words and their evidence, not your process (no "close call", "I keep", "I chose", "I did not check"); it does not explain or interpret the passage. Standard: about three to five sentences. Full: the same footnoted choices, each in more depth (Elsewhere, Traditions); full adds depth, not more footnotes.',
  'Scripture quoting Scripture: write the whole quotation in Unicode small-cap letters (lowercase becomes small caps, capitals stay full size, x stays x, q becomes ǫ); a quotation of more than one sentence or about 25 words in an indented block, shorter inline; superscriptions are not quotations. Footnote markers are Unicode superscript digits (¹ ² ³). Set in italics each supplied word that has no source word, inflection or construction behind it, including "is" in a verbless clause (in Dutch too).',
  'Attribute a reading to source evidence only when it was returned; include required attribution and any material limitation at every level. Edition flags are not manuscript evidence; call a reading provisional where only one source is returned or the evidence ties, and say what it rests on in a few words. Where the tool returns no text of a witness (LXX, Dead Sea Scrolls, Samaritan Pentateuch, a Targum, the Vulgate, New Testament manuscripts), your own knowledge may only flag and footnote a known difference, marked "(outside knowledge, unchecked)"; it never decides which reading is translated. Keep it out of every translation decision. At concise it appears only as a brief fragment in the "Limits:" line.',
  'When a passage quotes other Scripture, or an Old Testament passage is quoted in the New Testament, read the quoted passages and the quoting passages (the relevant direct quotations and plausible source passages, within available coverage, with the same Study tool calls at every level) before awarding quotation priority or calling a witness match decisive; label returned evidence, candidate links and what remains unresolved, and say apart when a comparison could not be finished because a witness is missing.',
  'Do not show scores, points or checks unless the reader asks how a reading was chosen; then show the points that decided it.',
  'When the asked verses depend on a larger unit, read it at every detail level. In a translation, give its argument in one or two sentences before the translation at standard and full, and do not write it at concise.',
  'Read the translation skill (or call get_guidance with topic "translation") before translating.',
]);

const DATA = `What is loaded can grow over time. The study tool reports which sources it read and with what coverage. At this version only original-language texts with word tagging are selected; manuscript-relationship comparisons, commentary and background search, study packages and word-by-word analysis of a whole passage are not offered yet, and the tool says so when a request needs them.`;

const PURPOSE =
  'Canonical Scripture Study — original-language Bible evidence. The study tool supplies attributed source evidence; you translate, reason and explain.';

const THROUGH_SKILL =
  'Every question goes through a skill. Before the first study call for a question, read the skill for its mode to its end: load it as a skill, or call get_guidance with its name as topic. It says how to work and how to answer, and ends with the skill_code that every study call requires.';

/** One skill: the modes it serves and the code a study call under it must carry. */
export interface StudySkill extends TaskSkill {
  modes: readonly Mode[];
  code: string;
}

/** A short mark of a skill's text (FNV-1a). It shows that the text was read to its end and
 *  changes with the text; it is no secret. */
function mark(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++)
    hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** How a skill starts its work. The rules for each argument stay with the study tool. */
function steps(modes: readonly Mode[], give: string): string {
  const named = modes.map(mode => `"${mode}"`).join(' or ');
  return `How to work:
- Call study with mode ${named}${give}. Pass the skill code at the end of this text as skill_code, on continuations too.
- Follow every continuation before answering, ${STEP_BY_STEP}; then answer step by step and say what is still to be read.
- Say what "limitations" and "remaining" leave out.`;
}

const EVIDENCE = ': passages in references, or one word search in search_leads';

const TRANSLATION_SECTION = `Working translation (key rules; the full rules are in the translation skill)
Translate from the evidence of this study and keep this skill's mode and code.
${bullets(...TRANSLATION_RULES)}`;

/** A skill's one text: how to work, the core method, the task, the presentation, what the
 *  skill carries from another one and, last, its code. */
function skill(
  name: string,
  description: string,
  modes: readonly Mode[],
  parts: readonly string[],
  give = EVIDENCE,
): StudySkill {
  const [task, ...carried] = parts;
  const body = [
    steps(modes, give),
    METHOD,
    task,
    ...presentation(name),
    ...carried,
  ].join('\n\n');
  const code = `${name}-${mark(body)}`;
  const text = `${body}\n\nSkill code: ${code}\nPass it as skill_code in every study call made under this skill.`;
  return Object.freeze({name, description, modes, code, text});
}

export const SKILLS: readonly StudySkill[] = Object.freeze([
  skill(
    'translation',
    'Translating a Bible passage with Study: read before any study call in mode translation.',
    ['translation'],
    [TRANSLATION],
  ),
  skill(
    'exegesis',
    "Explaining a Bible passage with Study in the light of God's revealed character, with background and weighed interpretations: read before any study call in mode passage or exegesis.",
    ['passage', 'exegesis'],
    [EXEGESIS, TRANSLATION_SECTION],
  ),
  skill(
    'comparison',
    'Comparing textual witnesses and passages with Study: read before any study call in mode comparison.',
    ['comparison'],
    [COMPARISON, TRANSLATION_SECTION],
  ),
  skill(
    'word-study',
    'Studying a Hebrew, Aramaic or Greek word with Study: read before any study call in mode word_study or word_analysis.',
    ['word_study', 'word_analysis'],
    [WORD_STUDY],
  ),
  skill(
    'theme',
    'Investigating a biblical theme or theological question with Study: read before any study call in mode theme.',
    ['theme'],
    [THEME],
  ),
  skill(
    'source-inspection',
    'Reading exact native source text with Study: read before any study call in mode inspect_source.',
    ['inspect_source'],
    [SOURCE_INSPECTION],
    ', the native reference in references and exactly one source revision in sources',
  ),
  skill(
    'conclusion-check',
    "Checking conclusions against God's revealed character with Study: read before any study call in mode conclusion_check.",
    ['conclusion_check'],
    [CONCLUSION_CHECK],
    '; it needs no references',
  ),
]);

/** Why a study call gets no evidence yet: it lacks the code of its mode's skill. The code is
 *  only in the skill, so the message says what to read and never repeats it. */
export function skillNeeded(mode: string, code?: string): string | null {
  const needed = SKILLS.find(skill => skill.modes.some(m => m === mode));
  if (!needed || code === needed.code) return null;
  const problem = code
    ? 'This skill_code is not the current one for'
    : 'No skill_code was given for';
  return `${problem} mode "${mode}". Read the "${needed.name}" skill to its end (load it, or call get_guidance with topic "${needed.name}"), then call study again with the same arguments and the skill_code it ends with.`;
}

export const GUIDANCE_TOPICS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SKILLS.map(skill => [skill.name, skill.text])),
);

const SKILL_ROUTES = `Skills and their study modes:
${bullets(...SKILLS.map(skill => `${skill.name}: ${skill.modes.join(', ')}`))}`;

/** Sent on initialize to both hosts: they lead to the skill, which holds the way of working. */
export const STUDY_INSTRUCTIONS = [PURPOSE, THROUGH_SKILL, SKILL_ROUTES].join(
  '\n\n',
);

/** The topic "all": where to start and what is offered; each skill has its own topic. */
const OVERVIEW = [STUDY_INSTRUCTIONS, DATA].join('\n\n');

export function guidance(topic?: string | null): {
  version: string;
  topic: string;
  text: string;
} {
  if (topic == null || topic === '' || topic === 'all')
    return {version: GUIDANCE_VERSION, topic: 'all', text: OVERVIEW};
  const text = GUIDANCE_TOPICS[topic];
  if (!text)
    return {
      version: GUIDANCE_VERSION,
      topic,
      text: `Unknown topic "${topic}". Topics: ${Object.keys(GUIDANCE_TOPICS).join(', ')}, all.`,
    };
  return {version: GUIDANCE_VERSION, topic, text};
}
