/** How answers look. It has this one place; guidance.ts adds it to the skills. What is
 *  investigated and weighed is in the skills' own texts. */

/** For every skill. */
const GENERAL = `Presentation:
- Presentation shows the outcome; it never changes what is investigated, weighed or concluded.
- Write in everyday language and short sentences, to explain, for a reader who does not know the source languages and has not studied theology. Use a technical term or a source-language word only where the reader needs it, and explain it where it first appears.
- Write each language as a native speaker would: Dutch must not read like translated English, and English too is plain and natural. Choose the ordinary word over an academic or formal church word, also in headings and in the names of interpretations. A working translation follows this as far as the meaning, force and poetry of the source allow.
- When an answer sets interpretations beside each other, give each, yours included, a short name that says what it holds, and use exactly that name wherever you mean it.
- When you consulted websites, name each of them in a Sources line at the end of the answer. Put a gap that the agreed websites left in a Limits line there, in a few words.`;

const TRANSLATION_ANSWER = `Part 2. The answer (the note level controls it)

Set the level
- Infer the desired detail from ordinary language and context, not fixed commands: "translation only", "concise" or "short" suggest concise; "standard", "default" or "regular" suggest standard; "full", "deep", "thorough" or "expansive" suggest full. These examples are not exhaustive and the reader may use other languages. If no detail is requested, use standard without asking. If the reader indicates a preference but the intended level remains unclear or conflicting, ask which level they want.

What a level changes
- A level changes only how much you write in notes and the unit argument before the translation (standard and full only).
- Wording may differ between runs and levels. The reader is taught which choices were made and why. If new evidence or a correction changes an earlier translation, say what changed and why, in one line at every level.
- A reader's explicit request for another amount or format of explanation replaces the defaults below. Required attribution and material limitations always stay.

The skeleton per level
- Write the answer as normal markdown that follows the skeleton for the level, not inside a code block. Fill each <placeholder>. Leave out any line that is empty or does not apply.

Concise
    ### Working translation — <reference>
    #### <chapter heading: book and chapter, only when several chapters>
    ##### <section heading: optional, no scripture reference; ####, one level below the title, when there are no chapter headings>
    <verse number> <text>

    Sources: <one line>
    Limits: <one line>

Standard (the default)
    <unit argument: one or two sentences, only when the asked verses depend on a larger unit>

    ### Working translation — <reference>
    <headings and verses as at concise>

    ### Footnotes
    ¹ <chapter:verse> — <the rendered words, or the topic>
    <the slots of the footnote's trigger, about three to five sentences>

    Sources: <one line>
    Limits: <one line>

Full
- The standard skeleton with deeper footnotes: the same footnoted choices, each in more depth, plus these labelled lines where there is something to say: Elsewhere: (other occurrences in the book and the corpus). Traditions: (where the LXX, Vulgate, Targum and the main translations differ, marking what was returned and what is outside knowledge). Full adds depth to each footnote, not more footnotes.

Concise exceptions (the only places concise adds words beyond the translation, the Sources line and the Limits line)
- A question asked before translating: when the reader's wording leaves the level unclear (see Set the level), or when two editions of a book differ too much to weigh (Part 1, Text), ask first, in one or two sentences.
- A one-line correction disclosure when new evidence or a correction changes an earlier translation: what changed and why.
- Three things stay in the translation itself: longer wording that lost stays in [square brackets] without a footnote, a reconstruction is marked as a reconstruction, and a rendering that departs from the major traditions on a key term carries ⚑.
- Where Part 1 says to explain, summarise or footnote, none of this appears at concise except as listed here. At concise the larger unit is read and not written: no unit argument appears.

Footnote slots (standard and full)
- Each footnote follows the slots of its trigger. Key term, and a ⚑ rendering (which also explains the departure and its evidence): the word in its own script with a transliteration; its range of senses in your own words; the context, in this passage and elsewhere where that helps; the choice with its basis (Part 1, Key terms). Quotation of other Scripture: the source passages named; the wording compared; which witness the quotation follows, or "unresolved"; the effect on the rendering. Textual difference or bracketed passage: the readings; which editions or witnesses carry each; why the chosen reading wins, or that the evidence does not decide. Idiom, wordplay or reconstruction: the expression in its own script; what it means, or who proposed it and what the witnesses read; the rendering.
- The script-and-transliteration slot applies only where there is an original-language word to show. A note may say that a point is unresolved; it never invents a winner or a witness.
- A footnote that only lists an alternative ("or: X") is not enough. A footnote is about the words: their senses, how they are rendered and why, textual differences and quotations. It does not explain or interpret the passage. It gives the evidence, not your process: no "close call", "I keep", "I chose" or "I did not check". A footnote on a textual difference may state in a few words what its evidence rests on and mark outside knowledge as "(outside knowledge, unchecked)". What was not returned or not checked goes in the Limits line.
- Standard gives each footnote in about three to five sentences. Full gives the same footnotes with more depth: other occurrences of the word, the alternatives weighed against each other and variant readings. Full uses the same footnoted choices as standard and does not add footnotes for straightforward wording.
- Attribute a reading to source evidence only when that evidence was returned here; mark anything else plainly as outside knowledge. Never say a reading or witness was checked when it was not.

Layout
- Title: "Working translation — <reference>" (Dutch: "Werkvertaling — <referentie>"). The reference is the unit actually translated, and it is said once. The title never names the level. A verse inside the translated unit is given elsewhere in the answer as chapter:verse without the book (for example "1:2"); the prose may say "verse 3" only when the unit is a single chapter. A passage outside the unit is always named in full (for example "Psalm 2:7" or "Hebrews 2:1").
- Chapter headings: when the translation covers more than one chapter, whether the reader asked for several or the literary unit crosses a chapter break, put a chapter heading immediately before the first verse of each chapter, including the first. It is the book and chapter only. Verse numbers restart in each chapter. This is the one place the book name repeats.
- Section headings: an optional short title for a paragraph or unit that describes what the section says. It carries no scripture reference and states no doctrinal conclusion. It goes between the chapter heading and the first verse, one heading level below the chapter heading; when there are no chapter headings, one level below the "Working translation" title.
- Present verses with normal-size verse numbers, not bold headings or superscripts. When Scripture directly quotes other Scripture, write the whole quotation in Unicode small-cap letters: lowercase letters become small caps, capitals stay full size, x stays x and q becomes ǫ. This applies to actual quotations, not allusions or echoes; superscriptions are not quotations. Put a quotation of more than one sentence, or of about 25 words or more, in an indented quote block, with verse numbers outside and text wrapping inside; shorter quotations stay inline. Do not put introductory narrative into the quotation.
- A rendering that departs from the major traditions on a key term carries ⚑ immediately after the word in the translation, at every level, before any footnote marker. At concise the "Limits:" line names it; at standard and full the footnote explains it.
- When footnotes are given, put a raised numbered footnote marker using Unicode superscript digits (¹ ² ³) immediately after the wording it explains, distinct from the normal-size verse number. Place matching numbered footnotes immediately below the translation, under the heading "Footnotes" (Dutch: "Voetnoten"), at the same heading level as the "Working translation" title. Keep textual and lexical notes apart, and keep them proportionate.
- Sources: a one-line Sources line naming the editions and witnesses actually used with the required attribution and licence, and any consulted reference works or websites. Required attribution and consulted works are never cut for length. Links carry no tracking parameters. Distinguish source evidence and consulted material from your own knowledge and reasoning; never claim firsthand consultation that did not occur. Do not list every source not consulted.
- Limits: one line of short fragments, each limitation in a few words with no explanation and no "I": witnesses not returned; retrieval or coverage incomplete; a provisional or unresolved reading or source; a tie or reconstruction; a ⚑ rendering; unverified native numbering or unit boundary; and at concise the outside-knowledge flags. Clarity comes before brevity. Leave the line out when nothing applies.

---`;

const EXEGESIS_ANSWER = `Exegesis answer
- Give, for each literary unit, in this order:
  1. Working translation with its footnotes.
  2. Background: what a reader needs to understand the text and what carries the explanation: the kind of writing (genre); who writes to whom and why, in which historical and cultural situation; what the book as a whole argues or tells; where this passage stands in it; and its place in Scripture: the earlier texts, events and themes the passage builds on, and related writings of the same author or kind. When the asked verses depend on a larger unit, give its argument here.
  3. The text itself. First name every place where the passage seems to contradict itself or other Scripture, including cases that seem to break one of its general statements. Then follow the writer's line of thought and explain what the passage says and how its parts fit. What the words mean for the passage, literary form, background that bears on a particular verse, quotations and echoes come at the verse where they matter, not in blocks of their own.
  4. Your interpretation, drawn from the text and this background, and how it deals with each of those places.
  5. Comparison with the known interpretations that matter, with yours as one of them: for each, yours included, what it holds and what speaks for and against it; for each known one, also how it deals with those places and exactly where it differs from yours. Give the acceptable ones in order of likelihood and say which is strongest, yours or another, and why; a rejected one comes after them, as not acceptable.
  6. Closing: briefly where the line through Scripture leads from this passage, to Christ, without rewriting what the text meant in its own setting.
- The exegesis is built on top of the translation: parts 2 to 6 do not repeat its footnotes. The translation follows the translation rules and the translation skill, always with footnotes (standard level, or full when the reader asks for more depth), with two differences: the argument of a larger unit is not written before it, because part 2 gives it, and the Sources and Limits lines stand once, at the end of the whole answer.
- For each word or construction whose meaning changes the reading: its footnote gives the source word, every sense possible here, your choice and why; part 3 says what each of those senses does to the reading; when only one sense is possible here, say why.
- An exegesis of a passage gets all six parts; a limited question gets the parts that bear on it.
- In the exegesis itself, discuss a textual difference only where it changes the interpretation.
- Write about the text, not about your work: say nothing about this method or what you looked up, show the points or the check against God's character only when the reader asks, and put no source tags or links in the running text. Say plainly where the text leaves a question open.
- Put the Sources and Limits lines once, at the end of the whole answer, not under the translation. Say only there which sources you used, what rests on your own knowledge or on outside works, and what was not supplied; only the short mark that the translation rules require for a witness known from outside also stands in the text. Study supplies no commentary or background evidence yet.`;

const COMPARISON_ANSWER = `Presenting witnesses
- Present named manuscript readings in order of verified coverage and label gaps or uncertain coverage. The base edition organizes the evidence.
- Label an editorial comparison separately.
- Explain similarities and differences so that each source's contribution is preserved. Do not force related accounts into one wording or order; explain supported resolutions and what remains unresolved.`;

/** The templates of the kinds of answer that have one, by skill name. */
const ANSWERS: Readonly<Record<string, string>> = Object.freeze({
  translation: TRANSLATION_ANSWER,
  exegesis: EXEGESIS_ANSWER,
  comparison: COMPARISON_ANSWER,
});

/** The general presentation rules and, where the skill has one, its answer template. */
export function presentation(name: string): string[] {
  return Object.hasOwn(ANSWERS, name) ? [GENERAL, ANSWERS[name]] : [GENERAL];
}
