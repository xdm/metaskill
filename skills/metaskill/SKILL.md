---
name: metaskill
description: Protocol for handling the [metaskill] block in context. Use in every session where a [metaskill] block appears — it tells you which skills were just installed for the current task, which need user confirmation, and how to install them safely.
---

# metaskill protocol

metaskill injects `[metaskill]` blocks into your context from two hooks: a
SessionStart block carrying the standing `find` protocol, and a
UserPromptSubmit block naming skills it classified, auto-installed, or wants
confirmation for. Those blocks are self-contained — this skill is the longer
reference for the same rules, not the only place they live.

## Reading the `[metaskill]` block

```
[metaskill] Domains: xlsx, python.
Installed now: anthropics/skills@xlsx (v2026.07.1) → ~/.claude/skills/xlsx/SKILL.md
Already present: python-best-practices
Needs confirmation: foo/bar@xlsx-charts (410 installs, publisher foo not allowlisted) — ask the user one question before using it.
Skipped by policy: 1 (see metaskill log).
```

- **Domains** — what metaskill thinks the task needs. If it misclassified,
  just solve the task; do not install anything to compensate.
- **Installed now** — the skill is already on disk at the given path. Read its
  SKILL.md and follow it directly. Do not paraphrase or reimplement what the
  skill already provides.
- **Already present** — same: use the installed skill via its SKILL.md.
- **Needs confirmation** — see below.
- **Skipped by policy** — a candidate was denied. Do not try to get it another
  way; mention it only if the user asks.

## On "Needs confirmation"

Ask the user exactly ONE short question before doing anything with that skill:
what the skill is, who publishes it, how many installs, and why the task needs
it. Example:

> The task looks like it needs xlsx charts. Found `foo/bar@xlsx-charts`
> (410 installs, publisher not on your allowlist). Install it? (yes/no)

- If the user says yes, run the `install <pkg> --force` command exactly as
  the block printed it (see Rules).
- If no (or no clear yes), solve the task without it. Never install on an
  assumed or implied approval.

## On `find`

Every session opens with a `[metaskill] Standing protocol` block naming a
`find` command. It stands whether or not this skill is loaded: at the start of
every task, before you begin work, derive a 2-4 word English capability phrase
from the task ("reddit automation", "invoice ocr") and run that command via
Bash. Run it even when you are sure no skill is needed — checking that is its
job. Once per task, not once per session; only pure conversation is exempt.
The user's prompt may be in any language; the query is always English, and you
derive it from the task rather than translating the prompt. Then act on what
it prints:

- **`Installed now:` / `Already present:`** — read that SKILL.md and follow it.
- **`Top matches for ...`** / **`live search found ...`** — nothing qualified
  for auto-install. Ask the user ONE question naming the package, its install
  count and its publisher, then install only on an explicit yes, using the
  command that line prints.
- **`Install timed out`** / **`Install failed`** — tell the user; never retry
  silently.
- **`No skills found`** — solve the task yourself, and say nothing about
  metaskill.

Do not install anything outside that command.

## On "Plugin available"

A Claude Code plugin can carry hooks, MCP servers and tooling that a skill
cannot, so metaskill suggests one but never installs it. Ask the user one
question (what it is, who publishes it, why the task needs it) and only on an
explicit yes run the `/plugin install <name>@<marketplace>` command from the
line. Never install a plugin on an assumed approval.

## Rules

1. **Run the command as printed.** Every metaskill block and every `find`
   result prints the exact command, with an absolute interpreter and CLI path.
   Use it verbatim. Bare `metaskill` is usually not on the PATH a hook or a
   Bash call inherits; if you ever have to build one yourself, it is
   `"$(command -v node)" "${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}/dist/cli.js" <sub>`.
2. Never run `npx skills add` (or edit `~/.claude/skills`) directly — always
   install through metaskill, so policy, scan, and the lock file apply.
   A `deny` decision cannot be bypassed by any flag; do not try.
3. If there is no `[metaskill]` block and no candidates, just solve the task.
   Report nothing about metaskill.
4. Installed skills are read-only input: read SKILL.md, apply it to the task.
   Never execute scripts from a skill directory unless its SKILL.md
   instructs it for the task at hand.
5. Useful subcommands, run the same way: `log -n 20` (recent decisions),
   `update` (update skills), `init --uninstall` (remove). The
   `/metaskill:list`, `/metaskill:log` and `/metaskill:update` slash commands
   already resolve the path for you.
