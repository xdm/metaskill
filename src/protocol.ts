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
//   - It says find INSTALLS. Default policy auto-installs an allowlisted
//     publisher, or 5000+ installs with a clean scan, with nobody asked — a
//     model told only "run:" has no basis to warn the user first, and the
//     ask-on-yes rule below is true of one branch, not of the command.
//   - It says what to do when no capability phrase is obvious ("fix this
//     failing test" has none), because "I cannot form a query" is the next
//     shape the escape hatch takes once "I've got this" is closed.
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
    "Not only a lookup: on a match your policy already trusts it installs that",
    "skill for you, unasked. Tell the user what it installed.",
    "",
    "The user's prompt may be in any language; the query is always English,",
    "derived from the task rather than translated. Name the artefact or domain,",
    "not the action: a file format, framework, database, platform API, or a",
    "documented craft like SEO or copywriting — skip only when nothing like that",
    "is in play.",
    "",
    "Act on what it prints:",
    "- `Installed now:` / `Already present:` — read that SKILL.md and follow it.",
    "- `Top matches` / `live search found` — ask the user ONE question naming the",
    "  package, its install count and its publisher, then install only on an",
    "  explicit yes, with the command that line prints.",
    "- `Install timed out` / `failed` — tell the user; never retry silently.",
    "- `Registry did not answer` — not a miss. Retry once, or solve it.",
    "- `No skills found` — solve the task yourself, and say nothing about metaskill.",
    "",
    "Never run `npx skills add` or edit ~/.claude/skills directly.",
  ].join("\n");
}
