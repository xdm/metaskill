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
//
// Keep it under ~1300 chars: it is paid for on every session start, and
// cliEntryPath() is longer for a plugin-cache install than in this checkout.
export function protocolText(): string {
  return [
    "[metaskill] Standing protocol — in force for every task in this session.",
    "",
    "At the start of every task, before you begin work, run:",
    "",
    `  ${metaskillCmd()} find "<2-4 english words for the capability>"`,
    "",
    "Run it before answering, not after.",
    "Run it even when you are sure no skill is needed — checking that is its job.",
    "Once per task, not once per session. Only pure conversation is exempt: a",
    "greeting, or a question about this session itself.",
    "",
    "The user's prompt may be in any language; the query is always English, and",
    "you derive it from the task rather than translating the prompt. Skills exist",
    "for file formats, frameworks, databases, platform APIs, and documented",
    "crafts like SEO or copywriting.",
    "",
    "Act on what it prints:",
    "- `Installed now:` / `Already present:` — read that SKILL.md and follow it.",
    "- `Top matches` / `live search found` — ask the user ONE question naming the",
    "  package, its install count and its publisher, then install only on an",
    "  explicit yes, with the command that line prints.",
    "- `Install timed out` / `failed` — tell the user; never retry silently.",
    "- `No skills found` — solve the task yourself, and say nothing about metaskill.",
    "",
    "Never run `npx skills add` or edit ~/.claude/skills directly; policy, scan",
    "and the lock file only apply through metaskill.",
  ].join("\n");
}
