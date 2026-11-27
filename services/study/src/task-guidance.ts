/** The texts of the study skills other than translating, and the rule blocks that skills share.
 *  Each rule is written once here or in guidance.ts. The rules for each tool argument stay with
 *  the tools. */

/** How witnesses are weighed; translating and comparing both use it. */
export const WITNESS_POINTS = `- Witnesses are weighed, not counted: many copies of one family or text type count as one voice.
- Points for the likely original wording:
  +2 the reading that best explains how the others arose.
  +1 supported against the other side by an independent witness (for example the Dead Sea Scrolls agreeing with the Septuagint against the Masoretic Text, or with the Masoretic Text against the Septuagint). Witnesses that go back to one older text-form count once.
  +1 the older witness.
  +1 the shorter reading, measured in meaning: fewer words or less content once translated, not longer words for the same meaning or spelling. 0 when a copying slip explains the difference (the eye skipping between similar words, a repeated word, look-alike letters).
  +1 the harder reading.
  +1 the reading that fits the author's own vocabulary, grammar and argument. This balances "harder": a reading that makes no sense in context is not rewarded.
  -1 a reading that removes an embarrassing or difficult element, smooths the text, or copies a parallel passage (for example Gospel harmonisation, or Samuel matched to Chronicles). Typical scribal additions count here too: an extra account of events already told, expanded divine names ("Jesus" to "the Lord Jesus Christ"), pious phrases, and a subject spelled out where the text left it implied.
  -1 a reading that exaggerates or glorifies, such as inflated numbers or an enlarged hero (for example Goliath's height or army sizes).
  -2 a reading that steers the theology (for example "sons of Israel" for "sons of God" in Deuteronomy 32:8, or softening God's human-like features). The scribal corrections the Masoretes themselves list (tiqqune sopherim) count here.
  For smoothing, embarrassment, exaggeration and theological steering, follow established scholarly assessments where known (for example Tov, McCarthy on the tiqqune sopherim, Metzger), named as outside knowledge.
  On a tie in the Old Testament, translate the Masoretic Text if it is one of the tied readings, and footnote the other reading. In any other unresolved case (a tie without the Masoretic Text, a New Testament tie, no Masoretic reading, or evidence too thin to prefer one reading), give the best-supported reading, or the main text returned here where nothing separates them, as a provisional translation; say plainly that the evidence does not settle it and footnote the significant alternatives.
  A reading earns no points when it is evidently a revision toward the Hebrew, which takes two things. First, a flag: an operative kaige range (a debated boundary range is shown as possible kaige and not discounted) or a cited judgment that marks that reading as kaige. Second, a usable, attributable non-kaige Greek witness whose own reading differs, or whose clear omission is attested, at those words. Without such a witness the flagged reading is the only usable Greek reading: keep it and mark it with its actual label (kaige, Hexaplaric, Theodotion and so on). A range mark alone does not discount a reading the non-kaige witnesses share. A witness that is silent, damaged or unrelated at those words does not count as one, and neither does an edition that only names manuscripts. Other revisions, such as Hexaplaric additions, Theodotion, Aquila or Symmachus, are named as what they are.
- New Testament quotations decide. Only a real quotation counts, not an allusion or echo. Where the New Testament quotes an Old Testament passage in a form that matches one witness (the Septuagint, the Masoretic Text or another), that reading wins, whichever witness it is. If New Testament quotations of the same passage follow different witnesses, or the New Testament wording matches no witness, no reading wins by quotation: the points decide, and a footnote explains the New Testament use.`;

/** How recurring biblical words are rendered; translating and word study both use it. */
export const TRANSLATION_KEY = `- YHWH is always "Yahweh"; never LORD, the LORD, HEERE or de HEERE.
- kyrios is Lord, lord or master by context. Identify it with Yahweh only where an Old Testament quotation or strong context warrants it, and say so.
- Keep Sheol, Hades, Gehenna, the abyss and Tartarus-related verbs distinct; explain each in context without importing a later doctrine of hell or of the afterlife.
- nephesh/psyche, ruach/pneuma/neshamah and basar/sarx/soma: decide each occurrence from its context (life, person, self, breath, wind, spirit, flesh, body ...) under the Key terms rules. One known trap: where a conventional rendering brings in Platonic soul-body dualism (an immortal, separable soul, such as "soul" for nephesh where the context means a living being or life), use the contextual meaning and note the conventional rendering. This concerns dualism only. It does not make ruach, pneuma or any other word suspect in itself, and does not rule out renderings such as "the Spirit of God" where the context supports them.
- aion/aionios: by context and construction; neither "always endless" nor "always age-long".
- torah, hesed, emet, and the vocabulary of faith, works, righteousness, justification, testing and temptation: follow the argument, subject, object and agency; no single universal gloss.
- A word's lexical range is not its meaning here; etymology is not proof; one English word may hide different source words, and one source word may carry different senses.`;

/** What the check against God's revealed character is; exegesis and the conclusion check both
 *  use it, and each says what the answer shows of it. */
export const CHARACTER_CHECK = `- Results with evidence do not carry the statement. conclusion_check returns the name, version, wording and scriptural basis (reader references) of the approved statement, or says that none is selected.
- With a statement: check your conclusions against its wording and its scriptural basis, and present only its own wording as the statement. It is never a premise and agreement proves nothing; a conflict means examining both the conclusion and the statement against Scripture.
- Without one: say so, check against what Scripture reveals about God's character, and call this your own check, not the approved version.
- Check every serious interpretation or alternative, not only the one you favour; when there is another serious reading, a check of the favoured one alone is incomplete.
- A reading that does not fit God's character as Scripture reveals it is never correct. When one seems not to fit, first examine both the reading and the statement against Scripture again; if it still does not fit, reject it as unacceptable, whatever else speaks for it, your own included.`;

export const EXEGESIS = `Exegesis:

The answer
- Read the whole literary unit, also when particular verses are asked; deliver the asked scope.
- Give, for each literary unit, in this order:
  1. Working translation, under the translation skill. Here it has no footnotes, also where the translation rules below ask for them: what a footnote would explain belongs at its verse in part 2.
  2. The text itself. When the asked verses depend on a larger unit, give its argument first. Then name every place where the passage seems to contradict itself or other Scripture, including cases that seem to break one of its general statements. Then follow the writer's line of thought and explain what the passage says and how its parts fit. Words, literary form, historical and cultural background, quotations and echoes come at the verse where they matter, not in blocks of their own.
  3. Your interpretation, drawn from the text, and how it deals with each of those places.
  4. Comparison with the known interpretations that matter: for each, where it agrees or differs, what speaks for and against it and how it deals with those places. Give them in order of likelihood, and say which is strongest, yours or another, and why.
  5. Closing: briefly the line through Scripture and to Christ, without rewriting what the text meant in its own setting.
- For each word or construction whose meaning changes the reading, give the source word, every sense possible here, what each sense does to the reading, your choice and why. An explanation that gives only the chosen sense is incomplete when another sense is possible here; when only one sense is possible here, say why.
- An exegesis of a passage gets all five parts; a limited question gets the parts that bear on it.

Language
- Write in everyday language and short sentences, for a reader who does not know the source languages. Use a technical term or a source-language word only where the reader needs it, and explain it where it first appears.
- Write about the text, not about your work: say nothing about this method, the points, the checks or what you looked up, and put no source tags or links in the running text. Say plainly where the text leaves a question open.
- Put the Sources and Limits lines once, at the end of the whole answer, not under the translation. Say only there which sources you used, what rests on your own knowledge or on outside works, and what was not supplied; only the short mark that the translation rules require for a witness known from outside also stands in the text. Study supplies no commentary or background evidence yet.

Work first
- Start with the text: read it closely and form your own interpretation before you turn to known ones.
- Investigate words, background, canon and interpretations, weigh them, check them against God's character, and only then write. In a study the user takes step by step, write a step when the research it rests on is done.
- In the exegesis itself, discuss a textual difference only where it changes the interpretation.
- A wish for a shorter or longer answer changes the length of the parts, not the research.

Background layers
- Consider the verse, paragraph, chapter and book or letter; the wider writings of the same or a similar author or kind (for example Paul's letters, the Gospels, John's writings, the prophets, wisdom writing, poetry); the testament; and the whole Bible.
- Historical and cultural background includes the ancient setting and where the passage stands against it.
- Research depth sets how far each layer is researched. A layer that bears on a claim is never left out.

Weighing interpretations (points)
  +2 the reading best explains the wording and grammar, hard details included.
  +2 it fits the argument of the paragraph and the book.
  +1 it fits the author's usage.
  +1 it fits the first audience and their world.
  +1 it is supported by other Scripture read in its own context (the strength of the support, not the number of passages).
  -1 it leaves a significant difficulty unexplained, such as a place named in part 2.
  -1 it needs a later system or outside concept to supply a premise.
  -2 it reasons in a circle.
- A reading that cannot stand without a premise that never counts as support is not named strongest, whatever its total. Historical and linguistic evidence may still illuminate the context.
- When totals are level, the reading with fewer unsupported assumptions goes first. If they are still level, say that the evidence does not decide.
- The number of scholars and the age of a tradition give no points. God's character gives no points: it is a check, never a premise.
- Before delivering, check for each point which reading the evidence supports best, not merely whether it fits the one you chose.
- Show points only when the reader asks; then show the points that decided.
- Your own interpretation is weighed by the same points. Coming first gives it no advantage: when another scores higher, name that one strongest and say why.
- Mark your own interpretation as your own and never attribute it to others; when it matches a known one, say so. Say what speaks against it, and give it nothing for being new.

Sources
- Attribute a reading to a person or tradition only when you are sure of it, and never as if you had read it firsthand.

God's character
- After weighing the points and before naming the strongest reading, read the conclusion-check skill and call study with mode "conclusion_check".
${CHARACTER_CHECK}
- In an exegesis this check is part of the weighing, like the points: do not write about the check, the statement or an outcome for each reading. When no statement is selected, the Limits line says so.
- Name a rejected reading in part 4, after the others, as not acceptable, with the reason; never offer it as strongest or as possible. If no reading remains, say that none is acceptable yet and leave the question open.
- When this affects which reading is strongest or how sure you are, give the reason with that reading, as a plain statement about the text and God.
- Show the check only when the reader asks; then name the statement with its version and say for each interpretation what it implies about God, where that fits his revealed character and where it creates tension, or why you find no tension.`;

export const COMPARISON = `Comparison:

- Read each witness on its own, with its own coverage, also when one source combines witnesses. Keep its wording, order, attribution and the state of each correspondence (exact, partial, reordered, disputed or unknown).
- Call something an omission only where the evidence attests it within that witness's recorded coverage; otherwise it is a gap. A shared verse number or a cross-reference alone does not establish correspondence.
- Say which witnesses and relationships were not returned or compared. Knowledge from outside the returned evidence is marked as such and is not a witness.
- Weigh witnesses only where suitable witness evidence is available, by the points below. Show points only when the reader asks how a reading was chosen.

Presenting witnesses
- Present named manuscript readings in order of verified coverage and label gaps or uncertain coverage. The base edition organizes the evidence.
- Label an editorial comparison separately. It stays outside the manuscript stream, the attestation counts, the witness grades and the witness coverage.
- Explain similarities and differences so that each source's contribution is preserved. Do not force related accounts into one wording or order; explain supported resolutions and what remains unresolved.

Weighing witnesses
- Cite the evidence for each judgment, and keep a judgment about a range apart from a judgment about a single reading.
${WITNESS_POINTS}`;

export const WORD_STUDY = `Word study:

- Settle the occurrence, its word form, dictionary form and grammar before explaining a word.
- Keep what a word can mean apart from what it means here. Decide the meaning here from the grammar, usage and context; a dictionary definition, a word root or a use elsewhere does not establish it.
- Give the attributed lexical candidates, keep words that share a spelling apart, and keep each source's entry and attribution distinct.
- List the occurrences you rely on with their surrounding wording, and state the searched extent. Call a list complete only within that extent.

Translation key (for rendering words; the Key terms rules are in the translation skill)
${TRANSLATION_KEY}`;

export const THEME = `Theme and theological investigation:

- Search beyond the passages usually cited or listed as cross-references: look for alternatives, objections and contrary evidence, follow supported quotations, allusions and parallels, and read each passage in its context.
- A search hit, a cross-reference or a shared word is a lead. It does not by itself establish a theme, a doctrine, a quotation or a shared meaning.
- A passage supports a claim only through its meaning in context; the number of citations does not make up for weak support.
- Label ranked or relevance-based results as ranked leads, and never treat such a shortlist as exhaustive. Call a listing complete only for the coverage actually searched, and state that coverage.
- Weigh traditional and scholarly explanations on their arguments and sources, and keep them apart from source evidence and your own conclusions.`;

export const SOURCE_INSPECTION = `Source inspection:

- Use it only when exact native text is still needed and the native reference is known: one source revision, read by its native numbering.
- Say that the text was read by native numbering and not by a checked mapping.
- A native candidate is unverified, not a checked match.`;

export const CONCLUSION_CHECK = `Conclusion check:

Run it after interpreting.
${CHARACTER_CHECK}
- Name the statement with its version. For each interpretation say what it implies about God, where that fits his revealed character and where it creates tension; if you find no tension, say so and why.`;
