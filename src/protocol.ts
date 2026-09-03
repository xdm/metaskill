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
//   - It states WHEN to ask as a rule with numbers in it, not as a judgement.
//     "Judge which row, if any, fits the task; if none does, solve it
//     yourself" is a slot the model fills with its own prior, and on the
//     first real v2 lookup it filled it with "none": five `ask` rows, a
//     1.16-relevance top row that plainly fitted, and nothing put to the
//     user. A reader asked to decide whether to ask has already been handed
//     the option not to. The bands come from the measured distributions in
//     read.ts's Hit comment — capability phrases: min 0.85, median 1.28;
//     junk queries: median 0.70, max 1.30. They overlap, which is why no
//     floor can gate the command; but 1.0 sits above the junk median and
//     below the capability median, so "at or above 1.0, ask" fires on nearly
//     every real phrase and rarely on junk, and 0.5 sits under both
//     distributions, where a row shares a word with the query and nothing
//     more. Prose alone did not hold: with the bands stated only here, the
//     ready-made question still printed at relevance 0.08, and a mechanism
//     that costs nothing exactly where the rule says stop is not a rule. So
//     `find` applies the bands itself (read.ts's RELEVANCE_BANDS) and prints
//     one line — `Ask the user:`, `Borderline match`, or `Weak matches only`
//     — and this block tells the model that that line, not its own reading of
//     the list, says what happens next. The two numbers quoted here are the
//     ones in RELEVANCE_BANDS; test/protocol.test.ts imports the constant and
//     fails if the text drifts from it.
//   - The bands apply to `Top matches` only, and `live search found` gets its
//     own line. A registry hit has no relevance to band — there is no ranked
//     list to place it in — and it is always askable, so it always prints a
//     question. Folded into one bullet with `Top matches`, the gate read as
//     applying to a branch that prints no number, which is guidance the
//     output cannot honour.
//   - It says what a low `relevance` means and what to do about it. Removing
//     the hard floor made the model's judgement the only filter, and `find`
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
//     the very judgement "run it even when you are sure" exists to forbid —
//     eleven lines under that sentence. The enumeration must never terminate
//     in a condition the model can answer "no" to.
//   - It does NOT warn against `npx skills add`. That duplicates SKILL.md
//     Rule 2 and spends scarce lines naming a bypass to a reader who was not
//     looking for one. Note what is and is not enforced: metaskill's OWN
//     install path cannot be talked past (a `deny` there survives every flag),
//     but nothing stops a model running the skills CLI directly — there is no
//     PreToolUse hook, so the ban on doing so is instruction, not enforcement.
//   - Asking is defined once, above the bands, and both asking bands inherit
//     it: an ask happens BEFORE the task, and it is a question the user is
//     given a turn to answer. Second real v2 use: a borderline row at 0.85,
//     correctly judged to fit, and the question printed as the last line of a
//     paragraph that had already begun answering the task — the user did not
//     experience it as a question at all. Two gaps in this text, not model
//     whim. Only the >= 1.0 band said "before anything else"; the borderline
//     band said "judge, then ask", which is satisfied by asking at the end of
//     an answer, so it now says "then ask first" (and find.ts's own cue says
//     the same, or the two disagree in the decision turn). And nothing said
//     HOW: Claude Code hands the model an AskUserQuestion tool that renders a
//     real yes/no choice, and it used prose instead. The instruction is
//     conditional because the tool is — it exists in an interactive session,
//     not in every harness — and the fallback names the property that failed:
//     one line of text and NOTHING else in that turn.
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
export function protocolText(): string {
  return [
    "[metaskill] Standing protocol — in force for every task this session.",
    "",
    "At the start of every task, before you begin work, run:",
    "",
    `  ${metaskillCmd()} find "<2-4 capability words>"`,
    "",
    "Run it before answering, not after.",
    "Run it even when you are sure; that check is its job.",
    "Once per task, not per session; pure chat is exempt.",
    "",
    "It never installs: nothing reaches disk without the user's explicit yes,",
    "unless they set `trust.auto_install: true`.",
    "",
    "The prompt may be in any language; the query is always English, from the",
    "task. Name the artefact or domain, not the action: a format, framework,",
    "or craft like SEO.",
    "",
    "Ask FIRST: before you start the task, not inside an answer. Use the",
    "AskUserQuestion tool if you have it (`Install <pkg>` / `No`), else one",
    "line of text and nothing else.",
    "",
    "Act on what it prints:",
    "- `Already present:` — read that SKILL.md, follow it.",
    "- `Top matches` — the line under the rows decides: `Ask the user:`",
    "  (`relevance` >= 1.0) — put it to the user before anything else;",
    "  `Borderline match` — judge whether it fits, then ask first;",
    "  `Weak matches only` (under 0.5) — a low `relevance`: it barely",
    "  matched, so decline it in silence.",
    "- `live search found` — no band: relay its question.",
    "- `Refused by policy` — never offer these; no flag installs them.",
    "- `Registry did not answer` — not a miss; retry once.",
    "- `No skills found` — solve it yourself, silently.",
  ].join("\n");
}
