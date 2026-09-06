import { metaskillCmd } from "./paths.js";

// v1 shipped this protocol in a plugin SKILL.md whose body only loads when
// something invokes it — nothing ever did — and phrased the per-prompt line as
// opt-out ("*If* a specialized skill could help…"): used 8 times in 244
// classification misses. This text is injected into every session by `sync`,
// and every sentence in it is load-bearing against that failure:
//
//   - The trigger is "every task", with a named exemption. A trigger the model
//     has to adjudicate ("if a skill would help", "a task a skill would do
//     better") is answered "no" by a model whose honest prior is that it can
//     handle the task — the conditional does the same work as v1's, in an
//     imperative's clothes.
//   - It says to run it even when sure. That is the instruction the measured
//     3% follow-through actually calls for, and v1 never gave it.
//   - Scope is explicit. "For this session" reads as "already did that" by the
//     third task in a long session.
//   - No cost or privacy reassurance. `find` is ~0.4s on a local index hit but
//     goes to the network on a miss (20s measured, ending in an install
//     timeout), so "costs milliseconds / offline" is disconfirmed on first
//     contact — and answering an objection the reader did not raise plants it.
//   - Every quoted label is a string find.ts actually prints; test/protocol
//     .test.ts cross-checks them against that file.
//   - It says find does NOT install, and names the one setting that changes
//     that. The command used to install the top-ranked hit unattended, and
//     this block used to warn about it; both are gone. Code ranks, the model
//     picks, `install` enforces policy (spec §4.4) — so the ask-the-user rule
//     is now true of the command as a whole, and saying so is what stops a
//     model reporting an install that never happened.
//   - It states WHEN to ask as a rule with a number in it, not as something
//     the model gets to decide. "Which row, if any, fits the task? If none
//     does, solve it yourself" is a slot the model fills with its own
//     prior, and on the first real v2 lookup it filled it with "none": five
//     `ask` rows, a 1.16-relevance top row that plainly fitted, and nothing
//     put to the user. A reader asked to decide whether to ask has already
//     been handed the option not to. Prose alone did not hold either: with
//     the rule stated only here, the ready-made question still printed at
//     relevance 0.08, and a mechanism that costs nothing exactly where the
//     rule says stop is not a rule. So `find` applies the threshold itself
//     (read.ts's MIN_ASK_RELEVANCE) and prints the line that follows from it
//     — `Ask the user:` under a `Likely fit` cue, or `Weak matches only` —
//     and this block tells the model that those lines, not its own reading
//     of the list, say what happens next. The number quoted here is the one
//     in MIN_ASK_RELEVANCE; test/protocol.test.ts imports the constant and
//     fails if the text drifts from it.
//   - TWO zones, not three. Between them there used to be a middle band,
//     0.5-1.0, whose line said "decide whether it fits, then ask" — the last
//     slot in which the model got to rule on whether to ask at all.
//     On 2026-09-04 the user's own five `find` calls ALL landed in it and
//     produced no question; four of the five deserved one. Three review
//     rounds ended the same way: a slot that permits skipping is used to
//     skip. What replaced it was measured, not chosen — the 52 calibration
//     queries and both curves are in read.ts's comment beside the constant —
//     and what the middle band was hedging against is handled above the line
//     by the description check, which is a check, not a discretion.
//   - The asking zone reads the row's description before it relays anything,
//     and that is a CHECK, not the discretion the threshold took away. A
//     probe of 47 everyday life and work queries plus the five real ones
//     found that 72% of the rows clearing the threshold do NOT deserve a
//     question, and they are homonyms a lexical score cannot see: "insomnia
//     help" -> a REST client called Insomnia, "stress management" ->
//     stress-test (load testing), "time management" -> a scheduler
//     component, "language learning" -> an LLM trainer. A rare query word
//     carries high idf, so the WRONG sense of it scores HIGH — no threshold
//     separates them, which is exactly why this check sits above the line
//     instead of being folded into it. The model can tell them apart from
//     the description printed on the row; BM25 cannot. So the zone names one
//     specific question with both outcomes stated — does this description
//     fit the task: ask, or say nothing — rather than "decide whether to
//     bother", which is the slot the first incident filled with "none".
//     test/fixtures/everyday-queries.json and calibration-queries.json are
//     that probe, kept as golden fixtures against the shipped snapshot.
//   - A row with no description to read is skipped, not asked about, and
//     `find` falls to the next readable row above the line rather than
//     silencing the query: 129 of the snapshot's 4,835 records carry no
//     description at all (registry sources that report installs and nothing
//     else), and `linkedin outreach prospecting` puts one of them on top
//     with a genuine match directly beneath it. Only when nothing above the
//     line can be read does the block's promise of a question go unkept, and
//     find.ts says so in the line where the question would have been.
//   - The third line under `Top matches` is `Policy allows this`, and it is
//     here because the case used to print nothing at all. With
//     `trust.auto_install: true` every row can come back `auto`, and then
//     find had no question to hand over and printed no line — under a header
//     promising that the line under the rows decides. A model told to act on
//     a line that never comes acts on its own reading of the list, which is
//     the failure this whole block is against. So find prints the concrete
//     install command for that row (no `--force`: the knob IS the standing
//     yes) and this line says to run it. One short line, because the printed
//     line already carries the command and the row it names; the reference
//     (SKILL.md) carries the rest.
//   - The threshold applies to `Top matches` only, and `live search found`
//     gets its own line. A registry hit has no relevance to place — no ranked
//     list to place it in — and it is always askable, so it always prints a
//     question. Folded into one bullet with `Top matches`, the gate read as
//     applying to a branch that prints no number, which is guidance the
//     output cannot honour.
//   - It says what a low `relevance` means and what to do about it. Removing
//     the hard floor made the model's reading the only filter, and `find`
//     prints a number the model has never been told how to read — beside a
//     policy reason ("publisher anthropics is allowlisted, scan clean") that
//     reads as an endorsement. Measured: `find "tell me a joke"` returns a
//     0.53-relevance account-research skill wearing exactly that reason. The
//     equivalent sentence in SKILL.md is not enough on its own: SKILL.md
//     loads on invocation, this block loads at session start.
//   - It says what to name when no capability phrase is obvious ("fix this
//     failing test" has none), because "I cannot form a query" is the next
//     shape the escape hatch takes once "I've got this" is closed. It offers
//     that as guidance and NOT as a gate: an earlier draft ended the clause
//     with "skip only when nothing like that is in play", which handed back
//     the very discretion "run it even when you are sure" forbids —
//     eleven lines under that sentence. The enumeration must never terminate
//     in a condition the model can answer "no" to. It names life and work
//     domains, not only IT: the list used to read "a format, framework, or
//     craft like SEO", which tells a model this command is for engineering
//     tasks — and the same probe found the registry answering "meal prep",
//     "salary negotiation" and "study techniques" too. A query never formed
//     is the one miss no threshold can catch. The list is not exhaustive and
//     cannot be at this length; it is priced per word, so each one earns its
//     place off the probe. `writing` covers two of the four fixture queries
//     that clear the threshold against the shipped snapshot (`email
//     writing`, `resume writing`) and is roughly a quarter of measured
//     everyday AI use; it is here in place of `travel`, which clears nothing.
//   - It does NOT warn against `npx skills add`. That duplicates SKILL.md
//     Rule 2 and spends scarce lines naming a bypass to a reader who was not
//     looking for one. Note what is and is not enforced: metaskill's OWN
//     install path cannot be talked past (a `deny` there survives every flag),
//     but nothing stops a model running the skills CLI directly — there is no
//     PreToolUse hook, so the ban on doing so is instruction, not enforcement.
//   - Asking is defined once, above the zones, and the asking zone inherits
//     it: an ask happens BEFORE the task, and it is a question the user is
//     given a turn to answer. Second real v2 use: a row at 0.85, correctly
//     read as fitting, and the question printed as the last line of a
//     paragraph that had already begun answering the task — the user did not
//     experience it as a question at all. Two gaps in this text, not model
//     whim. The old middle band said "decide, then ask", which is satisfied
//     by asking at the end of an answer; the rule now says FIRST wherever it
//     is stated, here and in find.ts's own cue, or the two disagree in the
//     decision turn. And nothing said
//     HOW: Claude Code hands the model an AskUserQuestion tool that renders a
//     real yes/no choice, and it used prose instead. The instruction is
//     conditional because the tool is — it exists in an interactive session,
//     not in every harness — and the fallback names the property that failed:
//     one line of text and NOTHING else in that turn. The option LABEL is the
//     skill name, not the package: real packages here run to 55 chars
//     (`ailabs-393/ai-labs-claude-skills@nutritional-specialist`), which no
//     option label renders, so the package goes in the option's description
//     where the user can still read what they are saying yes to.
//   - The query is "not translated". Both live incidents arrived as Russian
//     prompts, and a model that translates the prompt instead of naming the
//     capability searches for the user's phrasing rather than the artefact.
//     The contrast is two words and it earns them.
//   - `Registry did not answer` is listed separately from `No skills found`.
//     A live lookup that timed out is not evidence that no skill exists, and a
//     model given one label for both facts will report a coverage gap it never
//     established.
//
// Budget: the PROSE stays under 1400 chars (test/protocol.test.ts measures it
// with both absolute paths removed), and the injected string under 1600. The
// paths are not something the wording can trade against — process.execPath is
// 86 chars on the author's machine and cliEntryPath() is longer for a
// plugin-cache install than in this checkout. Everything above is paid for:
// the ask-first paragraph was bought back out of the language sentence, the
// skill-kind enumeration and the tail of each branch bullet, so nothing here
// is spare. Anything added later has to be traded the same way.
//
// What the description check and the life/work enumeration cost, and what
// paid for them: the "Act on what it prints:" lead-in (23 chars — the
// bullets are labels `find` prints and imperatives to obey, which is what
// the line said), "no band:" from the `live search found` bullet (that
// bullet's separateness already carries it), "read and follow" -> "follow",
// "in force for every task" -> "every task", "always English" -> "English",
// "that check is its job" -> "checking is its job", "the line under the
// rows" -> "the line under them", "pure chat is exempt" -> "pure chat
// exempt", and "so decline it" -> "decline it". The homonym gloss ("a
// different thing with the same word") did NOT fit here and lives in the two
// unbudgeted documents instead — find.ts's cue, which the model reads in the
// decision turn, and SKILL.md. This block keeps the rule in its shortest
// true form: read the description, then ask or say nothing.
//
// The `Policy allows this` line (33 chars with its indent and newline) was
// paid for out of what those trades left over, and it spends nearly all of
// it: the injected string is 1595 of 1600 and the prose 1375 of 1400.
// Nothing further fits. The next line added here has to buy its space from a
// sentence above it, and the two budget tests are what will say so.
export function protocolText(): string {
  return [
    "[metaskill] Standing protocol — every task, this session.",
    "",
    "At the start of every task, before you begin work, run:",
    "",
    `  ${metaskillCmd()} find "<2-4 capability words>"`,
    "",
    "Run it before answering, not after.",
    "Run it even when you are sure; checking is its job.",
    "Once per task, not per session; pure chat exempt.",
    "",
    "It never installs: nothing reaches disk without the user's explicit yes,",
    "unless `trust.auto_install: true`.",
    "",
    "The prompt may be in any language; the query is English, from the task,",
    "not translated. Name the artefact or domain, not the action: formats,",
    "frameworks, health, money, career, cooking, writing, learning.",
    "",
    "Ask FIRST: before you start the task, not inside an answer, via",
    "AskUserQuestion if you have it (`Install <skill name>` / `No`, package",
    "in the description), else one line of text and nothing else.",
    "",
    "- `Already present:` — follow that SKILL.md.",
    "- `Top matches` — the line under them decides. `Ask the user:`",
    "  (`relevance` >= 0.55) — read the row's description: a different thing",
    "  with the same word, or no description, say nothing; else ask it FIRST.",
    "  `Weak matches only` (under 0.55) — a low `relevance`: barely matched,",
    "  decline it in silence.",
    "  `Policy allows this` — run it.",
    "- `live search found` — relay its question.",
    "- `Refused by policy` — never offer these.",
    "- `Registry did not answer` — not a miss; retry.",
    "- `No skills found` — solve it yourself, silently.",
  ].join("\n");
}
