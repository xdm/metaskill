---
name: metaskill
description: Protocol for handling the [metaskill] block in context. Use in every session where a [metaskill] block appears — it tells you how to look up the skills a task needs, what the policy decision on each one means, and how to install one safely once the user has said yes.
---

# metaskill protocol

The long form of the `[metaskill]` block injected into each session.

## Safety

metaskill installs third-party skills, so its limits are the point. Nothing
reaches disk without the user's explicit yes (`trust.auto_install` is off by
default). Every candidate passes `~/.metaskill/metaskill.yaml` first: publisher
allowlist and deny lists, and a content scan for forbidden files and
patterns. A `deny` cannot be bypassed by any flag. Every install is recorded
in a lock file.

## On "Needs confirmation"

`install` prints this when policy says `ask` and no `--force` was given. Put
exactly ONE short question to the user — what the skill is, who publishes it,
how many installs, why the task needs it — and on an explicit yes re-run the
`install <pkg> --force` command as printed. No clear yes means
solve the task without it; never install on an assumed approval.

## On `find`

The `[metaskill] Standing protocol` block names a `find` command, and stands
with or without this skill: at the start of every task, before you begin
work, derive a 2-4 word English capability phrase from the task ("reddit
automation", "meal planning") and run that command via Bash. Run it even when you are sure; checking is its
job. Once per task, not per session; pure chat is exempt.
The prompt may be in any language; the query is always English: derive it
from the task, never translate the prompt.

`find` ranks and checks; it **never installs**: you relay the line it prints,
`install` enforces policy.

`relevance` is BM25's report of how much of your query a row matched. A match
is `relevance` >= 0.55; under that a low `relevance` means the row barely
matched, say nothing.

The deciding line under the rows is a rule `find` has already applied to the
top row you could still install, not a call you make.

- **`Ask the user: Install ... ? yes/no`** (`relevance` >= 0.55) — a likely
  fit: read the row's description. If it fits the task, ask that question
  first, relayed as printed — it already names the package, its installs,
  publisher and scan verdict. Not left unasked because you could do the task
  yourself: you almost always could; that is not what the question is for.
  Say nothing only on a check the row itself settles: a rare word scores high
  in the wrong sense too, so if it is a different thing with the same word —
  an `insomnia` REST client for a sleep question — or the description is
  blank or a bare `>` or `|`, solve the task in silence.
- **`Weak matches only`** (under 0.55) — say nothing.
- **`Policy allows this without asking`** — no question to put, but the same
  check: read the row's description, and run the command on that line only if
  it fits. A different thing with the same word — run nothing, say nothing.

Asking means asking before you start the task, not inside an answer you have
already begun: use the `AskUserQuestion` tool if you have it — option label
`Install <skill name>`, the package in its description, `No` as the other
option — else send one line of text and nothing else.

A no is an answer too: under the install command `find` prints an
**`On no run:`** line naming `metaskill decline <pkg> --matched "<phrase>"`.
Run it as printed on the user's no. It installs nothing: it records the
package in `~/.metaskill/declined.json`, so `find` hides it for 30 days and
`log --stats` can count answered questions; a later install clears it. Only
for a no the user gave — never for a homonym you passed over, never in the
weak zone.

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

A plugin can carry hooks and MCP servers a skill cannot, so metaskill
suggests one but never installs it. Ask the same one question; only on an
explicit yes run the `/plugin install <name>@<marketplace>` command printed.

## Rules

1. **Run the command as printed.** Every metaskill block and every `find`
   result prints the exact command, with an absolute interpreter and CLI path.
   Use it verbatim. Bare `metaskill` is usually not on PATH; the engine is
   `${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}/dist/cli.js`.
2. Never run `npx skills add` or edit `~/.claude/skills` directly — install
   through metaskill, so policy, scan and the lock file apply.
3. No `[metaskill]` block and no candidates: solve the task, report nothing
   about metaskill.
4. Installed skills are read-only input: read SKILL.md and apply it. Never
   run scripts from a skill directory unless its SKILL.md says to.
5. Other subcommands, run the same way: `log -n 20`, `update`,
   `init --uninstall`; the `/metaskill:*` slash commands resolve the path.
