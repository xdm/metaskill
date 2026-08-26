---
description: Show recent metaskill routing decisions (domains, installs, asks)
allowed-tools: Bash(node:*), Bash(metaskill:*)
---

!`M="${CLAUDE_PLUGIN_ROOT:-$HOME/.metaskill/bin}"; [ -f "$M/dist/cli.js" ] && node "$M/dist/cli.js" log -n 20 || metaskill log -n 20`

Show the log above to the user in a code block, newest entries last. If the
user asked about a specific domain or skill, point at the relevant lines in
one sentence. Add nothing else.
