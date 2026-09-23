import { metaskillCmd } from "./paths.js";

// The standing protocol `sync` injects at the start of every session. Every
// sentence is there for a measured reason — the rationale and the numbers
// are in DESIGN.md — and the whole block is budgeted: under 1400 chars of
// prose and under 1600 injected, enforced by test/protocol.test.ts. A line
// added here has to buy its space from a line above it.
//
// The shape it keeps:
//   - The trigger is "every task", stated as an imperative with one named
//     exemption. A trigger the model has to adjudicate is answered "no".
//   - It says find never installs, and names the one setting that changes
//     that, so the model never reports an install that did not happen.
//   - When to ask is a rule with a number in it, applied by `find` itself;
//     the block tells the model to act on the line `find` prints, not on its
//     own reading of the list. Two zones, no middle band.
//   - The one silence above the line is the description check: a homonym a
//     lexical score cannot see. Every label quoted here is one find.ts prints.
//   - Asking means first, before the task, as a real question — the
//     AskUserQuestion tool when the harness has it, else one bare line.
//   - A no has a command too (`On no run:`), so it is recorded and not
//     repeated.
//   - The query is English and names the artefact or domain, not the
//     action; the list of kinds names everyday domains, not only engineering.
//   - A timed-out registry lookup is a separate label from a miss.
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
    "On no, run the `On no run:` line.",
    "",
    "- `Already present:` — follow that SKILL.md.",
    "- `Top matches` — the line under them decides. `Ask the user:`",
    "  (`relevance` >= 0.55) — read the row's description: a different thing",
    "  with the same word, say nothing; else ask it FIRST.",
    "  `Weak matches only` (under 0.55) — a low `relevance`: barely matched,",
    "  say nothing.",
    "  `Policy allows this` — read, then run.",
    "- `live search found` — relay its question.",
    "- `Refused by policy` — never offer these.",
    "- `Registry did not answer` — not a miss; retry.",
    "- `No skills found` — solve it yourself.",
  ].join("\n");
}
