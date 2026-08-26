---
description: Install a skill through metaskill policy and scan (owner/repo@skill)
allowed-tools: Bash(node:*), Bash(metaskill:*)
---

!`M="${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}"; [ -f "$M/dist/cli.js" ] && node "$M/dist/cli.js" install $ARGUMENTS || metaskill install $ARGUMENTS`

Report the result above to the user in one or two lines.

- If it succeeded, say what was installed and where.
- If it printed "Needs confirmation", ask the user exactly one question
  (publisher, install count, why) and on an explicit yes run
  `metaskill install $ARGUMENTS --force` via Bash, then report.
- If it printed DENIED, tell the user the reason. Deny cannot be bypassed by
  any flag; do not try another way.
