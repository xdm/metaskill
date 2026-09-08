---
name: metaskill
description: Protocol for handling the [metaskill] block in context. Use in every session where a [metaskill] block appears — it tells you how to look up the skills a task needs, what the policy decision on each one means, and how to install one safely once the user has said yes.
---

# metaskill protocol

metaskill injects one `[metaskill]` block into your context: a standing
protocol naming a `find` command. This skill is the longer reference for the
same rules.

## On "Needs confirmation"

`install` prints this when policy says `ask` and no `--force` was given. Put
exactly ONE short question to the user — what the skill is, who publishes it,
how many installs, why the task needs it — and on an explicit yes re-run the
`install <pkg> --force` command exactly as it was printed. No clear yes means
solve the task without it; never install on an assumed approval.

## On `find`

The `[metaskill] Standing protocol` block names a `find` command, and stands
with or without this skill: at the start of every task, before you begin
work, derive a 2-4 word English capability phrase from the task ("reddit
automation", "meal planning") and run that command via Bash. Run it even when you are sure no skill is needed — checking that is its
job. Once per task, not per session; pure chat is exempt.
The prompt may be in any language; the query is always English: derive it
from the task, never translate the prompt.

`find` ranks and checks; it **never installs**. It prints the top candidates
with their install count, scan verdict, relevance and policy decision, and
stops: code ranks and applies the rule below, you relay the line it prints,
`install` enforces policy. Nothing reaches disk without the
user's explicit yes, unless they set `trust.auto_install: true` in
`~/.metaskill/metaskill.yaml` (off by default).

`relevance` is BM25's report of how much of your query a row matched. A match
is `relevance` >= 0.55; under that a low `relevance` means the row barely
matched the words — decline it in silence.

The number on the row `find` singles out decides what happens next; it is a
rule, not a call you make. `find` applies it and prints the deciding line
under the rows, about the top row you could still install.

- **`Ask the user: Install ... ? yes/no`** (`relevance` >= 0.55) — a likely
  fit: read the row's description. If it fits the task, ask that question
  first, relayed as printed — it already names the package, its installs,
  publisher and scan verdict. Not left unasked because you could do the task
  yourself: you almost always could; that is not what the question is for.
  Say nothing only on a check the row itself settles: a rare word scores high
  in the wrong sense too, so if it is a different thing with the same word —
  an `insomnia` REST client for a sleep question — or the description is
  blank or a bare `>` or `|`, solve the task in silence.
- **`Weak matches only`** (under 0.55) — decline and say nothing.
- **`Policy allows this without asking`** — no question to put, but the same
  check: read the row's description, and run the command on that line only if
  it fits. A different thing with the same word — run nothing, say nothing.

Asking means asking before you start the task, not inside an answer you have
already begun: use the `AskUserQuestion` tool if you have it — option label
`Install <skill name>`, the package in its description, `No` as the other
option — else send one line of text and nothing else.

`find` never asks about a row whose description is blank or a bare `>` or
`|`: no question is printed for a row you cannot check. If a readable row
under it clears 0.55, the question names THAT row and the line says
which it stepped over; with no readable row at all it prints no question and
no install command — say nothing and solve the task.

A **`live search found`** hit has no relevance and no scan verdict, so it is
always `ask`. It prints its question — ask it the same way.

Act on what it prints:

- **`Already present:`** — read that SKILL.md and follow it.
- **`Top matches for ...`** / **`live search found ...`** — the line under
  the rows is the instruction; the rule above is already applied.
  Install only on an explicit yes, with the command that line prints.
- **`Refused by policy`** — not installable by any flag. Never offer them;
  do not ask about them.
- **`Registry did not answer`** — a lookup that never completed, not evidence
  that no skill exists. Run `find` once more, or solve the task without one.
- **`No skills found`** — solve the task yourself, and say nothing about
  metaskill.

## On "Plugin available"

A plugin can carry hooks, MCP servers and tooling a skill cannot, so metaskill
suggests one but never installs it. Ask one question the same way; only on an
explicit yes run the `/plugin install <name>@<marketplace>` command from the
line.

## Rules

1. **Run the command as printed.** Every metaskill block and every `find`
   result prints the exact command, with an absolute interpreter and CLI path.
   Use it verbatim. Bare `metaskill` is usually not on the PATH a hook or
   Bash call inherits; if you must build one yourself, it is
   `"$(command -v node)" "${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}/dist/cli.js" <sub>`.
2. Never run `npx skills add` (or edit `~/.claude/skills`) directly — always
   install through metaskill, so policy, scan, and the lock file apply.
   A `deny` decision cannot be bypassed by any flag; do not try.
3. If there is no `[metaskill]` block and no candidates, just solve the task.
   Report nothing about metaskill.
4. Installed skills are read-only input: read SKILL.md, apply it to the task.
   Never execute scripts from a skill directory unless its SKILL.md
   instructs it for the task at hand.
5. Useful subcommands, run the same way: `log -n 20`, `update`,
   `init --uninstall` (remove). The
   `/metaskill:list`, `/metaskill:log` and `/metaskill:update` slash commands
   resolve the path for you.
