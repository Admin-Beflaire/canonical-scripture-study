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
- New Testament quotations decide. Only a real quotation counts, not an allusion or echo. Where the New Testament quotes an Old Testament passage in a form that matches one witness (the Septuagint, the Masoretic Text or another), that reading wins, whichever witness it is. If New Testament quotations of the same passage follow different witnesses, or the New Testament wording matches no witness, no reading wins by quotation: the points decide, and a footnote gives the New Testament wording.`;

/** How recurring biblical words are rendered; translating and word study both use it. */
export const TRANSLATION_KEY = `- YHWH is always "Yahweh"; never LORD, the LORD, HEERE or de HEERE.
- kyrios is Lord, lord or master by context. Identify it with Yahweh only where an Old Testament quotation or strong context warrants it, and say so.
- Keep Sheol, Hades, Gehenna, the abyss and Tartarus-related verbs distinct; explain each in context without importing a later doctrine of hell or of the afterlife.
- nephesh/psyche, ruach/pneuma/neshamah and basar/sarx/soma: decide each occurrence from its context (life, person, self, breath, wind, spirit, flesh, body ...) under the Key terms rules. One known trap: where a conventional rendering brings in Platonic soul-body dualism (an immortal, separable soul, such as "soul" for nephesh where the context means a living being or life), use the contextual meaning and note the conventional rendering. This concerns dualism only. It does not make ruach, pneuma or any other word suspect in itself, and does not rule out renderings such as "the Spirit of God" where the context supports them.
- aion/aionios: by context and construction; neither "always endless" nor "always age-long".
- torah, hesed, emet, and the vocabulary of faith, works, righteousness, justification, testing and temptation: follow the argument, subject, object and agency; no single universal gloss.
- A word's lexical range is not its meaning here; etymology is not proof; one English word may hide different source words, and one source word may carry different senses.`;

/** How God's character bears on a reading; exegesis and the conclusion check both use it, and
 *  each says when it is read and what the answer shows of it. */
export const CHARACTER_RULES = `- Results with evidence do not carry the statement. conclusion_check returns the name, version, wording and scriptural basis (reader references) of the approved statement, or says that none is selected.
- With a statement: hold every reading and every theological conclusion to every part of the statement, and present only its own wording as the statement. Read a passage from the scriptural basis only when the part of the statement it supports matters for that conclusion. It is never a premise and agreement proves nothing: what a reading says must come from the text. A conflict means examining both the reading and the statement against Scripture.
- Without one: say so, go by what Scripture reveals about God's character, and call this your own check, not the approved version.
- God's character, as the whole of Scripture reveals it, tests a reading; a reading never redefines that character. Good, just and loving keep their meaning when used of God. A reading that can stand only by bending them is wrong. Do not argue that an act must be good simply because a reading attributes it to God: that is circular reasoning.
- When a reading seems not to fit, first examine both the reading and the statement against Scripture again. How sure you are counts: when it clearly still does not fit, reject it as unacceptable, whatever else speaks for it, your own included; when that stays uncertain, do not reject it, but lower how sure you are of it and say why.`;

export const EXEGESIS = `Exegesis:

Work first, in this order
  a. Start with the text: read the whole literary unit, also when particular verses are asked, and deliver the asked scope. Read closely and note every place where the passage seems to contradict itself or other Scripture, including cases that seem to break one of its general statements.
  b. Read the statement of God's character, as "God's character" below says.
  c. In its light, investigate the words, background and canon the passage needs.
  d. Then form your own interpretation before you turn to known ones.
  e. Investigate the known interpretations, test them against God's character, and weigh all interpretations, yours included.
  f. Write the answer, and test it as a whole before you deliver it, as "God's character" below says.
- In a study the user takes step by step, write a step when the research it rests on is done, test it before you deliver it, and test again every conclusion that a later step changes.
- A wish for a shorter or longer answer changes the length of the parts, not the research.

Word meanings
- For each word or construction whose meaning changes the reading, work out every sense possible here, what each does to the reading, and which you choose and why. An explanation that gives only the chosen sense is incomplete when another sense is possible here.

God's character
- Before you form your own interpretation, read the conclusion-check skill and call study with mode "conclusion_check".
- Work out your own interpretation of every passage in the light of God's character from start to end: working it out and testing it go together. An explanation that clearly clashes with any part of it is not an option: look further in the wording, grammar, background and canon for one that fits.
- Your interpretation still comes from the text and accounts for everything the text says, hard places included. Where you cannot yet explain a place so that it both fits God's character and accounts for the text, say what remains uncertain, and bend neither of them.
- Test every known interpretation that matters against God's character, not only the ones close to yours.
- Before you deliver, test every theological conclusion that the finished answer draws or leaves possible against every part of the statement, or without one against what Scripture reveals about God's character: in your interpretation, the explanation of the text, the background, the comparison and the closing, with everything the weighing changed. Rework from the text what clearly does not fit and test it again; say what stays uncertain.
${CHARACTER_RULES}
- God's character is part of the work, like the points: do not write about the check, the statement or an outcome for each reading unless the reader asks to see the check. When no statement is selected, the Limits line says so.
- Where God's character shapes how a place is explained, or which reading is strongest or how sure you are, give that reason there, as a plain statement about the text and God.
- Name a rejected reading in part 5, after the others, as not acceptable, with the reason; never offer it as strongest or as possible. If no reading remains, say that none is acceptable yet and leave the question open.
- Show the check only when the reader asks; then name the statement with its version and say for each interpretation what it implies about God, where that fits his revealed character and where it creates tension, or why you find no tension.

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
  -1 it leaves a significant difficulty unexplained, such as a place named in part 3.
  -1 it needs a later system or outside concept to supply a premise.
  -2 for each fault in its grounds: a fallacy (circular reasoning among them), a mistranslation, or passing over texts that say otherwise (count such a text here, not also as an unexplained difficulty).
- A theological premise that only an outside philosophical or religious concept, a later system or circular reasoning supplies never counts as support.
- A reading that cannot stand without a premise that never counts as support is not named strongest, whatever its total. Historical and linguistic evidence may still illuminate the context.
- When totals are level, the reading with fewer unsupported assumptions goes first. If they are still level, say that the evidence does not decide.
- The number of scholars and the age of a tradition give no points. God's character gives no points and is never a premise.
- Before delivering, check for each point which reading the evidence supports best, not merely whether it fits the one you chose.
- Show points only when the reader asks; then show the points that decided.
- Each interpretation is one explanation of this passage; a tradition's label alone, or one doctrine the passage touches, is not an interpretation to rank.
- Your own interpretation is weighed by the same points, as one of its own beside the known ones, also when it is close to one of them. Coming first gives it no advantage: when another scores higher, name that one strongest and say why.
- Mark your own interpretation as your own and never attribute it to others; when it matches a known one, say so. Say what speaks against it, and give it nothing for being new.

Sources
- Attribute a reading to a person or tradition only when you are sure of it, and never as if you had read it firsthand.`;

export const COMPARISON = `Comparison:

- Read each witness on its own, with its own coverage, also when one source combines witnesses. Keep its wording, order, attribution and the state of each correspondence (exact, partial, reordered, disputed or unknown).
- Call something an omission only where the evidence attests it within that witness's recorded coverage; otherwise it is a gap. A shared verse number or a cross-reference alone does not establish correspondence.
- Say which witnesses and relationships were not returned or compared. Knowledge from outside the returned evidence is marked as such and is not a witness.
- Weigh witnesses only where suitable witness evidence is available, by the points below. Show points only when the reader asks how a reading was chosen.

Weighing witnesses
- Cite the evidence for each judgment, and keep a judgment about a range apart from a judgment about a single reading.
- An editorial comparison is no manuscript witness: it stays outside the manuscript stream, the attestation counts, the witness grades and the witness coverage.
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

Read the statement with it before you form an explanation of your own, and use it to check readings and conclusions that already exist, those of your finished answer included.
${CHARACTER_RULES}
- Asked for on its own, name the statement with its version, check each conclusion against every part of the statement, and for each interpretation say what it implies about God, where that fits his revealed character and where it creates tension; if you find no tension, say so and why.
- Asked for on its own, check every serious interpretation or alternative, not only the one you favour; when there is another serious reading, a check of the favoured one alone is incomplete.
- Run as part of an exegesis, the answer shows of this check only what the exegesis skill says.`;
