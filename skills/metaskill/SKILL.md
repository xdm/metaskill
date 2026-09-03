---
name: metaskill
description: Protocol for handling the [metaskill] block in context. Use in every session where a [metaskill] block appears — it tells you how to look up the skills a task needs, what the policy decision on each one means, and how to install one safely once the user has said yes.
---

# metaskill protocol

metaskill injects one `[metaskill]` block into your context, from a
SessionStart hook: a standing protocol naming a `find` command. That block is
self-contained — this skill is the longer reference for the same rules, not
the only place they live. Running `find` prints its own `[metaskill]` line
naming what it found and what policy thinks of each candidate (see "On `find`"
below).

## On "Needs confirmation"

`install` prints this when policy says `ask` and no `--force` was given. Put
exactly ONE short question to the user — what the skill is, who publishes it,
how many installs, why the task needs it — and on an explicit yes re-run the
`install <pkg> --force` command exactly as it was printed (see Rules). No
clear yes means solve the task without it; never install on an assumed or
implied approval.

## On `find`

Every session opens with a `[metaskill] Standing protocol` block naming a
`find` command. It stands with or without this skill: at the start of every
task, before you begin work, derive a 2-4 word English capability phrase
from the task ("reddit automation", "invoice ocr") and run that command via
Bash. Run it even when you are sure no skill is needed — checking that is its
job. Once per task, not once per session; only pure conversation is exempt.
The prompt may be in any language; the query is always English: derive it
from the task, never translate the prompt.

`find` ranks and vets; it **never installs**. It prints the top candidates
with their install count, scan verdict, relevance and policy decision, and
stops there — code ranks and applies the rule below, you relay the line it
prints, and `install` enforces policy on the package it names. Nothing reaches
disk without the user's explicit yes, unless they set `trust.auto_install:
true` in `~/.metaskill/metaskill.yaml` (off by default).

`relevance` is BM25's report of how much of your query a row matched. A full
match sits around 1.0 or above; a low `relevance` means the row barely matched
the words — decline it.

The number on the row `find` singles out decides what happens next; it is a
rule, not a call you make. `find` applies it: under the rows it prints exactly
one line, about the top row you could still install.

- **`Ask the user: Install ... ? yes/no`** (`relevance` >= 1.0) — put that
  question to the user, before anything else. Not left unasked because you
  could do the task yourself: you almost always could; that is not what the
  question is for. The line already names the package, its install count, its
  publisher and its scan verdict, so relay it as printed.
- **`Borderline match`** (`relevance` >= 0.5) — judge whether that row really
  fits the task. The cue prints the question for you — "ask exactly this,
  first, and nothing else: ..." — so if it fits, ask that, first.
- **`Weak matches only`** (under 0.5) — decline and say nothing. The row
  shares a word with your query and little else.

Asking means asking before you start the task, not inside an answer you have
already begun: use the `AskUserQuestion` tool if you have it — option label
`Install <skill name>`, the full package in its description, `No` as the
other option — else send one line of text and nothing else.

A **`live search found`** hit is different: the registry returns no relevance,
so there is no band to apply, and with no scan verdict it is always `ask`. It
always prints its question — ask that one the same way.

Act on what it prints:

- **`Already present:`** — read that SKILL.md and follow it.
- **`Top matches for ...`** / **`live search found ...`** — the line under
  the rows is the instruction; `find` has already applied the rule above to
  the row it names. Install only on an explicit yes, using the command that
  line prints.
- **`Refused by policy`** — those packages are not installable by any flag.
  Never offer them; do not ask about them.
- **`Registry did not answer`** — a lookup that never completed, not evidence
  that no skill exists. Run `find` once more, or solve the task without one.
- **`No skills found`** — solve the task yourself, and say nothing about
  metaskill.

## On "Plugin available"

A plugin can carry hooks, MCP servers and tooling a skill cannot, so metaskill
suggests one but never installs it. Ask one question the same way (what it is,
who publishes it, why the task needs it) and only on an explicit yes run the
`/plugin install <name>@<marketplace>` command from the line. Never on an
assumed approval.

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
