---
name: metaskill
description: Protocol for handling the [metaskill] block in context. Use in every session where a [metaskill] block appears — it tells you which skills were just installed for the current task, which need user confirmation, and how to install them safely.
---

# metaskill protocol

metaskill is a UserPromptSubmit hook that classifies each task, auto-installs
trusted skills from skills.sh, and injects a `[metaskill]` block into your
context. This skill tells you how to act on that block.

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

- If the user says yes, run: `metaskill install <pkg> --force`
- If no (or no clear yes), solve the task without it. Never install on an
  assumed or implied approval.

## On "Task not classified"

You are the classifier here. If a specialized skill could genuinely help the
task, derive a short English capability phrase (2-4 words, e.g. "reddit
automation", "invoice ocr") and run the `route --search "..."` command the
block gives you via Bash. Read its output and act on it: use what it
installed, ask the user the one question if it needs confirmation, or just
solve the task if nothing was found. Do not install anything outside that
command.

## On "Plugin available"

A Claude Code plugin can carry hooks, MCP servers and tooling that a skill
cannot, so metaskill suggests one but never installs it. Ask the user one
question (what it is, who publishes it, why the task needs it) and only on an
explicit yes run the `/plugin install <name>@<marketplace>` command from the
line. Never install a plugin on an assumed approval.

## Rules

1. Never run `npx skills add` (or edit `~/.claude/skills`) directly — always
   go through `metaskill install`, so policy, scan, and the lock file apply.
   A `deny` decision cannot be bypassed by any flag; do not try.
2. If there is no `[metaskill]` block and no candidates, just solve the task.
   Report nothing about metaskill.
3. Installed skills are read-only input: read SKILL.md, apply it to the task.
   Never execute scripts from a skill directory unless its SKILL.md
   instructs it for the task at hand.
4. Useful commands: `metaskill log -n 20` (recent decisions),
   `metaskill update` (update skills), `metaskill init --uninstall` (remove).
