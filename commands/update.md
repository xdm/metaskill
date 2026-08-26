---
description: Update skills installed by metaskill (allowlisted publishers; --force for the rest)
allowed-tools: Bash(node:*), Bash(metaskill:*)
---

!`M="${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}"; [ -f "$M/dist/cli.js" ] && node "$M/dist/cli.js" update $ARGUMENTS || metaskill update $ARGUMENTS`

Report the result above in one or two lines: what was updated, what was
skipped and why. If something was skipped as not allowlisted, mention the
user can re-run with `--force` after reviewing it. Add nothing else.
