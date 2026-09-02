import { cliEntryPath } from "./paths.js";

// v1 shipped this protocol in a plugin SKILL.md whose body only loads when
// something invokes it — nothing ever did — and phrased the per-prompt line as
// opt-out ("*If* a specialized skill could help…"), which reads as "skip":
// used 8 times in 244 classification misses. This text is injected into every
// session by `sync`, and is written as a standing instruction with a default
// action. Keep it under ~1400 chars; it is paid for on every session start.
export function protocolText(): string {
  const cli = `node "${cliEntryPath()}"`;
  return [
    "[metaskill] Standing protocol for this session.",
    "",
    "Before you start a task that a specialised skill would do better — working",
    "with a file format, a framework, a database, a platform API, a documented",
    "craft like SEO or copywriting — check whether such a skill exists:",
    "",
    `  ${cli} find "<2-4 english words for the capability>"`,
    "",
    "The user's prompt may be in any language; the query is always English, and",
    "you derive it from the task, not by translating the prompt. The lookup is",
    "local and offline, it costs milliseconds, and it never sends your prompt",
    "anywhere. Run it before answering, not after.",
    "",
    "Act on what it prints:",
    "- `Installed now:` / `Already present:` — read that SKILL.md and follow it.",
    "- `Top matches:` — ask the user ONE question naming the package, its",
    "  install count and its publisher, and install only on an explicit yes with",
    `  \`${cli} install <pkg> --force\`.`,
    "- `No skills found` — solve the task yourself, and say nothing about metaskill.",
    "",
    "Never run `npx skills add` or edit ~/.claude/skills directly; policy, scan",
    "and the lock file only apply through metaskill.",
  ].join("\n");
}
