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
//     more. The numbers live here, not in the injected text: the text says
//     what to do, and the reader cannot check a distribution anyway.
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
//   - `Registry did not answer` is listed separately from `No skills found`.
//     A live lookup that timed out is not evidence that no skill exists, and a
//     model given one label for both facts will report a coverage gap it never
//     established.
//
// Budget: the PROSE stays under 1400 chars (test/protocol.test.ts measures it
// with both absolute paths removed). The paths are not something the wording
// can trade against — process.execPath is 86 chars on the author's machine and
// cliEntryPath() is longer for a plugin-cache install than in this checkout.
export function protocolText(): string {
  return [
    "[metaskill] Standing protocol — in force for every task this session.",
    "",
    "At the start of every task, before you begin work, run:",
    "",
    `  ${metaskillCmd()} find "<2-4 english words for the capability>"`,
    "",
    "Run it before answering, not after.",
    "Run it even when you are sure no skill is needed — checking that is its job.",
    "Once per task, not once per session; only pure conversation is exempt.",
    "",
    "It ranks and vets; it never installs. Nothing reaches disk without the",
    "user's explicit yes — unless they set `trust.auto_install: true`.",
    "",
    "The user's prompt may be in any language; the query is always English,",
    "derived from the task rather than translated. Name the artefact or domain,",
    "not the action: a file format, framework, platform API, or a craft like",
    "SEO or copywriting.",
    "",
    "Act on what it prints:",
    "- `Already present:` — read that SKILL.md and follow it.",
    "- `Top matches` / `live search found` — top row `relevance` >= 1.0: put its",
    "  printed `Ask the user:` question to the user before anything else. Under",
    "  0.5, a low `relevance` means it barely matched — decline it, silently. In",
    "  between, judge. Install only on an explicit yes, with the command printed.",
    "- `Refused by policy` — no flag installs these. Never offer them.",
    "- `Registry did not answer` — not a miss. Retry once, or solve it.",
    "- `No skills found` — solve the task yourself, and say nothing about metaskill.",
  ].join("\n");
}
