# metaskill

[![npm](https://img.shields.io/npm/v/%40xdma%2Fmetaskill)](https://www.npmjs.com/package/@xdma/metaskill)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

You give Claude Code a task. Before it writes a line, metaskill looks for a
skill that fits (spreadsheets, Postgres, LinkedIn posts, whatever the job is),
checks it against your trust policy, and Claude asks you one question: install
it? You say yes or no. Nothing is installed behind your back, and you never go
looking for skills yourself.

```bash
/plugin marketplace add xdm/metaskill
/plugin install metaskill@metaskill
```

That is the whole setup. Without plugins, `npx @xdma/metaskill init` does the
same thing by hand (see [Install](#install)).

metaskill runs inside Claude Code only, through its `UserPromptSubmit` and
`SessionStart` hooks. The skills it installs are readable by other agents
too, because the `skills` CLI links them into Codex, Cursor and others.

## Why

A curated SKILL.md beats improvisation: the xlsx skill produces workbooks
with live formulas instead of a CSV with an `.xlsx` extension, and the
security-review skill runs a checklist instead of vibes. That is why
[skills.sh](https://skills.sh) has thousands of them.

A skill only helps if it is installed before the task, and that step is
manual: know a skill exists, search the registry, compare candidates, decide
whom to trust, install, keep it updated.

metaskill does that step. At the start of every task it checks what is
installed, ranks a local index of the registry, and hands Claude a shortlist
with a policy verdict per candidate. Claude reads the top row and asks you
before anything is installed.

## What happens on a prompt

```
$ claude
> export the quarterly report to xlsx with formulas and conditional formatting
```

1. A protocol injected at session start tells Claude to run `metaskill find`
   before starting any task.
2. Claude derives a short capability phrase and runs
   `metaskill find "xlsx export formulas"`.
3. `find` ranks the local index, keeps the top five, runs each past the
   policy, and prints the question and the two commands that follow it:

```
Ask the user: Install davila7/claude-code-templates@xlsx (957 installs, publisher davila7, scan clean) for this task? yes/no
Install only on the user's explicit yes: "/Users/you/.nvm/versions/node/v24/bin/node" "/Users/you/.metaskill/bin/dist/cli.js" install davila7/claude-code-templates@xlsx --force --matched "xlsx export formulas"
On no run: "/Users/you/.nvm/versions/node/v24/bin/node" "/Users/you/.metaskill/bin/dist/cli.js" decline davila7/claude-code-templates@xlsx --matched "xlsx export formulas"
```

<details>
<summary>Full output (three of the five rows shown)</summary>

```
[metaskill] Top matches for "xlsx export formulas" — find does not install. The line under the rows has applied these rules to the top row you could install: `Ask the user:` (relevance >= 0.55) — read that row's description; if it is a different thing with the same word, or has no description, say nothing and solve the task; otherwise ask that question FIRST, before any work; `Weak matches only` (under 0.55) — solve the task yourself, silently; `Policy allows this without asking` (you set `trust.auto_install`) — no question to put: read that row's description, then run the command that line names.
  davila7/claude-code-templates@xlsx (957 installs, scan=clean, relevance=1.03) [ask: needs your yes — publisher davila7 not allowlisted]
    Spreadsheet toolkit (.xlsx/.csv). Create/edit with formulas/formatting, analyze data, visualization, recalculate formulas, for spreadsheet p
  datadrivenconstruction/ddc_skills_for_ai_agents_in_construction@xlsx-construction (111 installs, scan=unknown, relevance=0.81) [ask: needs your yes — publisher datadrivenconstruction not allowlisted]
    Excel/spreadsheet processing for construction: estimates, schedules, tracking logs, quantity takeoffs. Formulas, formatting, analysis.
  vasilyu1983/ai-agents-public@document-xlsx (866 installs, scan=clean, relevance=0.79) [ask: needs your yes — publisher vasilyu1983 not allowlisted]
    Create/edit .xlsx spreadsheets with tables, formulas, charts, validation, and workbook automation. Use when asked to generate Excel reports,
Likely fit (relevance 1.03) — read the row's description first: if it fits the task, ask the question below, first, via the tool if you have it; if it is a different thing with the same word, say nothing and solve the task; if the description is blank or a bare mark (`>`, `|`), you cannot confirm the fit — say nothing and solve the task.
Ask the user: Install davila7/claude-code-templates@xlsx (957 installs, publisher davila7, scan clean) for this task? yes/no
Install only on the user's explicit yes: "/Users/you/.nvm/versions/node/v24/bin/node" "/Users/you/.metaskill/bin/dist/cli.js" install davila7/claude-code-templates@xlsx --force --matched "xlsx export formulas"
On no run: "/Users/you/.nvm/versions/node/v24/bin/node" "/Users/you/.metaskill/bin/dist/cli.js" decline davila7/claude-code-templates@xlsx --matched "xlsx export formulas"
```

</details>

4. `find` installs nothing. Each row shows the install count, the scan
   verdict, the relevance (how much of the query the row matched) and the
   policy verdict.
5. The line under the rows is what Claude acts on. At relevance 0.55 and
   above a ready-made question prints, under a cue to read the row's
   description first: a rare word ranks its wrong sense just as high
   ("insomnia help" finds a REST client called Insomnia), and only a reader
   can tell. Below 0.55 it prints `Weak matches only` and Claude solves the task alone. The threshold was
   measured on 52 queries, see [DESIGN.md](DESIGN.md).
6. You say yes, Claude runs the printed install command. You say no, Claude
   runs the decline command and the package stays out of `find` for 30 days.

A local index hit is one fast subprocess call. Installing, or the one live
registry search on an index miss (capped at 4 seconds), is what takes time.

The registry's best-known `anthropics/skills@xlsx` (172,369 installs) is
missing from that list on purpose: the index marks it `dirty` (an `os.environ`
read in a script it ships), and `dirty` is denied before the allowlist is
consulted. Which packages rank on a given day depends on the registry.

## Trust policy

Every candidate walks the same pipeline: lookup, scan verdict, policy
decision, your yes, pinned install. The model only proposes; the policy file
and you decide.

The decision table, first match wins:

| Condition | Decision |
|---|---|
| skill in `deny_skills`, or its publisher in `deny_publishers` | deny |
| scan verdict is `dirty` | deny |
| no real install count yet (`estimated`) | ask |
| scan carries an advisory | ask |
| publisher in `allowlist` and scan clean | auto-install |
| 5000 or more installs and scan clean | auto-install |
| anything else | ask |

One rule sits over the table: while `trust.auto_install` is `false` (the
default) every auto-install becomes ask, keeping its reason. Set it to `true`
to get the automatic path back. `deny` is never affected by that switch.

```yaml
trust:
  allowlist: [anthropics, vercel-labs]   # waives the install threshold; gates auto-update
  auto_threshold:
    min_installs: 5000
    require_clean_scan: true
  auto_install: false   # true lets a trusted, clean match install without asking
  deny_skills: []       # full owner/repo@skill; blocks one skill from a trusted publisher
  deny_publishers: []
```

What backs the table up:

- The scan verdict comes from the index, not from a download at decision
  time. Every indexed skill was fetched, unpacked and checked once for hook
  directories, `.mcp.json`, `curl `, `wget `, `eval(`, `process.env`,
  `os.environ` and a size limit. A pattern hit inside documentation is an
  advisory; the same pattern in code denies. A package the index has never
  seen (`metaskill install <owner/repo@skill>` by hand) gets the same scan,
  live.
- `deny` cannot be bypassed by any flag, on install, update or the daily
  sync.
- The hook never runs skill code. It downloads, reads and greps. Skills run
  later, inside Claude, as if you had installed them by hand.
- Every install is pinned in `~/.metaskill/skills-lock.json`. The one thing
  that runs unattended is the daily update of skills you already approved,
  from allowlisted publishers only, skipping anything now scanned dirty. It
  never installs a skill you do not have.
- Your prompt stays on your machine. `find` queries the registry with a
  short English phrase Claude derives from the task, and only when the local
  index has no match. The per-prompt hook logs a sha256 hash of the prompt,
  nothing else. metaskill never calls a model API, so there is no key and no
  second bill.
- `find` fails safe. On an error, a registry outage or a timeout it prints
  one line and changes nothing. A registry that does not answer prints
  `Registry did not answer`, not "no skill exists".
- Plugins are suggested, never installed. When a task matches a Claude Code
  plugin from a marketplace you added, metaskill names it and stops.
- `metaskill init --uninstall` removes everything it set up.

## Where it helps

Three prompts and the top row `find` returns for them today:

| You type | Top row |
|---|---|
| "Export the numbers to .xlsx with formulas and conditional formatting" | `davila7/claude-code-templates@xlsx` (957 installs) |
| "Add Playwright tests for the checkout flow" | `microsoft/playwright-cli@playwright-cli` (163,199 installs) |
| "Add meta tags and a sitemap, indexing looks broken" | `addyosmani/web-quality-skills@seo` (46,838 installs) |

If no skill fits, Claude solves the task and the gap is logged.

## Install

Requirements: Node 20 or newer, Claude Code, and the `skills` CLI (invoked
as `npx skills`, tested against v1.5.23).

As a plugin, inside Claude Code:

```
/plugin marketplace add xdm/metaskill
/plugin install metaskill@metaskill
```

Claude Code wires up the hooks, the protocol skill and the `/metaskill:*`
commands, keeps them updated, and `/plugin uninstall metaskill` removes them.
Nothing is written to your `settings.json`.

As a CLI, for a project-scoped setup (`--project`), a pinned version, or an
environment without plugins:

```
npx @xdma/metaskill init
```

`init` copies its engine to `~/.metaskill/bin/` so the setup survives npx
cache pruning and Node upgrades (re-run it after upgrading), registers two
hooks in `~/.claude/settings.json` (or `.claude/settings.json` with
`--project`) next to any hooks you already have, writes the default policy
to `~/.metaskill/metaskill.yaml` (never overwritten), and installs the
protocol skill and the `/metaskill:*` commands. `metaskill init --uninstall`
reverses all of it; installed skills, policy, log and lock stay.

Pick one channel: `init` refuses to run while the plugin is installed, so a
prompt is never routed twice.

## Commands

```
metaskill init [--project] [--uninstall]
metaskill find "<capability words>"                # ranks the local index; never installs
metaskill install <owner/repo@skill> [--force]      # policy + scan apply
metaskill decline <owner/repo@skill>                # your no: find hides the package for 30 days
metaskill update [names...] [--force]
metaskill list                                      # what metaskill installed (alias: ls)
metaskill plugins [words]                           # search plugin marketplaces (suggest only)
metaskill log [-n N] [--stats]                      # decisions, or follow-through and answered questions
metaskill route                                     # UserPromptSubmit hook body: logs the prompt
metaskill sync [--force]                            # SessionStart hook body: injects the protocol, refreshes the index
```

`--force` bypasses `ask`, never `deny`. With `trust.auto_install` off every
install is an ask, so `--force` is how Claude records your yes.

`decline` records your no. Installing the package later clears it, and so
does deleting its entry from `~/.metaskill/declined.json`. A no is tied to a
package name: if a later index keeps a different copy of the same skill,
that copy is offered afresh.

## Files and log

State lives in `~/.metaskill/`: `metaskill.yaml` (policy),
`skills-lock.json` (pins), `declined.json` (your noes, 30 days each),
`cache.json` (24h cache of live registry searches), `log.jsonl` (decisions,
90-day retention), `state.json` (24h sync gate and notices for the next
session).

```
$ metaskill list
SKILL         PACKAGE                                     VERSION  MATCHED             INSTALLED   STATUS
reddit-posts  kostja94/marketing-skills@reddit-posts      -        reddit launch post  2026-09-08  ok
postgres      planetscale/database-skills@postgres        -        postgres            2026-09-02  ok

$ metaskill log -n 2
2026-09-24T12:35:05.260Z domains=[] 3ms
2026-09-24T12:30:46.108Z domains=[find:image generation svg png assets] ask:vercel-labs/json-render@image(1429,scan=clean) ...
```

MATCHED is the phrase that found the skill. A log line with `domains=[]` is
a prompt (`route` records only that one happened); a `find:` line is a
lookup, followed by the rows it found. `metaskill log --stats` prints the
share of prompts followed by a lookup and the number of questions answered
(installs plus declines).

The index: the npm package ships a snapshot of the 13,048 skills with a real
install count (6.9 MB), enough to look things up offline right after
install. `sync` upgrades it to the full index, currently 33,413 skills across
785 repositories, from a nightly GitHub Release, at most once a day; the
download is about 24 MB with a 45-second budget, and a failed refresh keeps
the previous copy.

## Troubleshooting

- Nothing prints when I submit a prompt. By design: the per-prompt hook
  only records that a prompt happened. Discovery happens when Claude runs
  `find` at the start of a task. `metaskill log` shows both.
- `find` seems to hang. A local hit is fast; the one network fallback is
  capped at 4 seconds and ends in `Registry did not answer` if the registry
  is silent. It never blocks your prompt.
- `update` refuses a skill, citing a dirty scan. No flag bypasses that. The
  index found a denied pattern in the skill's current source; the refusal
  lifts when the registry scans it clean.
- An install times out. Installs get 120 seconds; run the printed command
  again.
- Claude found a skill but did not install it. That is the default. Claude
  asks first; `--force` records your yes. For unattended installs of
  trusted, clean matches set `auto_install: true`.

## Development

The reasoning behind the main decisions, with the measurements, is in
[DESIGN.md](DESIGN.md).

```
npm install
npm test          # build + unit/integration tests (stubbed skills CLI, temp HOME)
```

The registry index is built separately, since it makes live network calls:

```
npm run build:index   # sweeps skills.sh, scans every repo, writes index.json
```

The build keeps one record per skill: aggregator repositories and whole-repo
forks carry the same SKILL.md under their own package names, and the copy
that survives is the one with the higher real install count, then the one
from the repository that shares skills with the fewest others. A nightly
workflow publishes the result as the `index-latest` GitHub Release asset,
gated on description coverage and on the previous record count, so a
degraded run never overwrites a good index.

MIT © xdm
