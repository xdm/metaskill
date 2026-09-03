# metaskill

[![npm](https://img.shields.io/npm/v/%40xdma%2Fmetaskill)](https://www.npmjs.com/package/@xdma/metaskill)
[![skills.sh](https://skills.sh/b/xdm/metaskill)](https://skills.sh/xdm/metaskill)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

Claude Code works out which skills a task needs, vets them against your trust
policy, installs them safely once you say yes, then solves the task. You never
search for, compare, or hunt down skills manually.

```bash
/plugin marketplace add xdm/metaskill
/plugin install metaskill@metaskill
```

That's the whole setup, typed inside Claude Code. If you'd rather not use
plugins, `npx @xdma/metaskill init` wires up the same thing by hand. Details
and uninstall are in [Install](#install) below.

metaskill runs **inside Claude Code only**, through its hook system
(`UserPromptSubmit` / `SessionStart`) — both install methods below end up
there. The skills it installs are readable by other agents too (the `skills`
CLI links them into Codex, Cursor and others), but the
"find what this task needs" loop is Claude Code only for now.

## Why this exists

Agent skills work. A curated SKILL.md reliably beats improvisation: the xlsx
skill produces workbooks with live formulas instead of a CSV wearing an
`.xlsx` extension, the security-review skill runs an actual checklist instead
of vibes. That's why [skills.sh](https://skills.sh) has grown into thousands
of them.

But a skill only helps if it's installed *before* the task, and that part is
entirely manual: you have to know a skill exists for the thing you're about
to ask, search the registry, compare candidates, judge which publishers to
trust, install the winner, and keep everything up to date. Nobody actually
does this. Most people install two or three skills the week they discover the
registry, then forget it exists, and Claude quietly goes back to
improvising.

metaskill is exactly what the name says, a meta-skill: **the skill of finding
and managing skills, done for you.** At the start of every task, before
Claude answers, it checks what's already installed, ranks a local index of
the registry for the gap, and hands Claude a shortlist with a trust-policy
verdict on each candidate. Claude picks the one that actually fits and asks
you before anything is installed. You type the task; the toolkit assembles
itself, one confirmed install at a time.

```
$ claude
> export the quarterly report to xlsx with formulas and conditional formatting
```

Between pressing Enter and Claude's first token:

1. A standing protocol, injected at the start of the session, tells Claude to
   run `metaskill find` before starting any task — this one included.
2. Claude derives a short capability phrase and runs:
   `metaskill find "xlsx export formulas"`.
3. `find` ranks a local index of the registry, keeps the top five, and runs
   each one past the trust policy:

```
[metaskill] Top matches for "xlsx export formulas" — find does not install. The line under the rows has applied the relevance rule to the top row you could install: `Ask the user:` (relevance >= 1.0) — put that question to the user before anything else; `Borderline match` — judge whether it fits, then ask; `Weak matches only` (under 0.5) — solve the task yourself.
  aiskillstore/marketplace@xlsx (237 installs, scan=unknown, relevance=1.12) [ask: needs your yes — publisher aiskillstore not allowlisted]
    Spreadsheet toolkit (.xlsx/.csv). Create/edit with formulas/formatting, analyze data, visualization, recalculate formulas, for spreadsheet p
  davila7/claude-code-templates@xlsx (949 installs, scan=clean, relevance=1.12) [ask: needs your yes — publisher davila7 not allowlisted]
    Spreadsheet toolkit (.xlsx/.csv). Create/edit with formulas/formatting, analyze data, visualization, recalculate formulas, for spreadsheet p
  aaaaqwq/agi-super-team@xlsx (~0 est installs, scan=clean, relevance=0.94) [ask: needs your yes — no real install count (0 estimated from siblings)]
    Comprehensive spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. When Clau
  ailabs-393/ai-labs-claude-skills@xlsx (876 installs, scan=clean, relevance=0.94) [ask: needs your yes — publisher ailabs-393 not allowlisted]
    Comprehensive spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. When Clau
  anthropics/claude-agent-sdk-demos@xlsx (159 installs, scan=clean, relevance=0.94) [ask: needs your yes — auto-install is off; publisher anthropics is allowlisted, scan clean]
    Comprehensive spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. When Clau
Ask the user: Install aiskillstore/marketplace@xlsx (237 installs, publisher aiskillstore, scan unknown) for this task? yes/no
Install only on the user's explicit yes: "/Users/you/.nvm/versions/node/v24.17.0/bin/node" "/Users/you/.metaskill/bin/dist/cli.js" install aiskillstore/marketplace@xlsx --force --matched "xlsx export formulas"
```

4. **`find` installs nothing. It ranks, vets, and stops.** Each row carries
   its install count, scan verdict, `relevance` (how much of the query the
   row matched, on a scale that means the same thing whatever index you have
   loaded) and the policy's verdict. The last row is allowlisted with a clean
   scan, and reads `auto-install is off` because that is the shipped default:
   the verdict is computed in full, then held for your yes.
5. The last line is the one Claude acts on. Above 1.0 relevance the question
   is written out for it — package, publisher, install count, scan verdict —
   because a question Claude has to compose is a question it talks itself out
   of asking. Between 0.5 and 1.0 it gets `Borderline match` and has to judge
   the row first; below 0.5, `Weak matches only` and it solves the task
   itself. Nothing installs without your explicit yes, with the command that
   line printed.

A local index hit like this is one fast subprocess call; installing a skill —
or, on an index miss, the one live registry search, capped at 4 seconds — is
what actually takes time.

As of this writing, the registry's much bigger, better-known
`anthropics/skills@xlsx` (161,878 installs) never appears here at all: the
local index marks that specific package `dirty` (next section), and `dirty` is
denied before the allowlist is even consulted, however a query ranks it. This
walkthrough is a live snapshot, not a promise — which packages rank, and
whether the top one is trusted, depends on the registry on the day you read
it.

## Why it's safe to let an agent install things

An agent that installs packages is the part that should worry you, so it's
the part with the most machinery. Nothing reaches `~/.claude/skills` because
"the model felt like it": every candidate walks a fixed pipeline
(look up → scan verdict → policy decision → your yes → pinned install). The
model's only say is which candidate it proposes to you; what may be installed
at all, and on whose word, is the policy file's decision and yours.

The decision table, in order, first match wins:

| Condition | Decision |
|---|---|
| skill in `deny_skills`, or its publisher in `deny_publishers` | **deny** |
| scan verdict is `dirty` | **deny** |
| no real install count yet (`estimated`) | ask |
| scan carries an advisory | ask |
| publisher in `allowlist` (`anthropics`, `vercel-labs` by default) **and** scan clean | auto-install |
| ≥ 5000 installs **and** scan clean | auto-install |
| anything else | ask the user first |

Then one rule over the whole table: while `trust.auto_install` is `false` —
the shipped default — every **auto-install** above is downgraded to **ask**,
carrying its original reason with it (`ask: needs your yes — auto-install is
off; publisher anthropics is allowlisted, scan clean`) behind the four words
every `ask` opens with. Nothing new lands on your disk without you saying
yes, whatever the policy would otherwise permit. Set
`auto_install: true` when you want the automatic path back; `deny` is
untouched either way, because that switch only ever lowers what may happen
unattended.

What backs it up:

- **The scan verdict comes from the index, not a decision-time download.**
  Every skill in the local index already carries a verdict from the same
  static scanner that ships in this package: its GitHub archive was fetched
  once, unpacked to a temp dir, and checked for hook directories, `.mcp.json`,
  `curl `/`wget `, `eval(`, `process.env`, `os.environ`, and a size limit —
  before `find` ever has to decide. A pattern hit inside documentation (a
  `.md` file, say) becomes an advisory instead of an outright denial; the same
  patterns in real code still deny. Naming a package the index has never seen
  (`metaskill install <owner/repo@skill>` by hand) falls back to that same
  scan, live, before deciding.
- **`find` never installs.** It ranks the local index, runs each candidate
  past the policy, prints the shortlist with a verdict per row, and stops.
  The division of labour is deliberate: code ranks and applies the relevance
  rule, Claude relays the line it prints (and judges the borderline band,
  where only a reader who understands the task can tell), and
  `metaskill install` enforces the policy on that package. An earlier
  version let the top-ranked hit install itself, and BM25 duly installed
  third-party skills for prompts like "say hello".
- **`deny` cannot be bypassed by any flag — install, update, or the
  unattended sync update alike.** A `dirty` verdict is exactly as final as a
  denied publisher, even for an already-installed, allowlisted skill: as of
  this writing the index marks `anthropics/skills@xlsx` dirty (a real
  `os.environ` read in the script it ships), so if you already have it
  installed, `metaskill update` — manual or automatic — will refuse it and
  say why, until the registry scans it clean again.
- **The hook never executes skill code.** It downloads, reads, and greps.
  Skills run later, inside Claude, exactly as if you'd installed them by hand.
- **Everything is pinned.** Each install lands in
  `~/.metaskill/skills-lock.json` with source and version. The one thing that
  still runs unattended is the daily auto-**update** (24h-gated `SessionStart`
  hook): it refreshes skills you already installed and approved, from
  allowlisted publishers only, and skips anything the index now scans dirty.
  It never installs a skill you don't already have, so `trust.auto_install`
  does not gate it — and it can only ever move a package you already trusted
  to its current version. What it did (or skipped, and why) is reported at the
  start of the *next* session, since a hook may only emit one line and the
  protocol always goes out first.
- **The registry index ships in the package and refreshes itself.** A fresh
  install can look skills up offline immediately: the npm package carries a
  trimmed snapshot — the 4,831 skills with a real install count, about
  0.42 MB gzipped — covering everything the policy could actually auto-install
  on sight. `sync` upgrades that to the full index, currently 43,714 skills
  across 793 repositories, from a nightly GitHub Release, at most once every
  24 hours. That download is uncompressed and currently about 23.8 MB,
  budgeted 45 seconds; a failed refresh just keeps the previous copy.
- **Your prompt stays private, in any language.** `find`'s registry queries
  are a short English capability phrase Claude derives from the task (e.g.
  "reddit automation"), never your prompt text — and most of the time they
  never leave your machine at all, since they run against the local index
  first. The `UserPromptSubmit` hook that fires on every prompt logs only a
  sha256 hash of it, to measure how often a prompt is actually followed by a
  lookup. metaskill never calls a model API itself — the model deriving the
  query is the one already running your session — so there is no key to set
  and no second bill, ever.
- **It fails safe.** `find` always exits cleanly, even mid-failure: on an
  internal error, a registry outage, or a timeout, it prints one line and
  changes nothing — it has nothing to leave half-done, since it writes
  nothing. Installs get 120s. The one network call `find` can make (local
  index miss → live registry search) is capped at 4s, and a registry that
  never answers prints a distinct `Registry did not answer` line rather than
  being reported as "no skill exists."
- **A human decides, by default on every install.** Claude is instructed to
  ask you exactly one question (publisher, install count, why the task needs
  it) and to install only after an explicit yes, via the same policy-checked
  path. That is the shipped behaviour for every package, trusted or not,
  until you turn `auto_install` on.
- **Plugins are suggested, never installed.** When a task matches a Claude
  Code plugin from a marketplace you already added, metaskill surfaces it and
  stops there. Plugins can add hooks and MCP servers, so installing one is
  always your call: `metaskill plugins <words>` to browse, `/plugin install`
  to accept.
- **One command to leave.** `metaskill init --uninstall`.

Tune all of it in `~/.metaskill/metaskill.yaml`:

```yaml
trust:
  allowlist: [anthropics, vercel-labs]        # waives the install threshold; gates auto-update
  auto_threshold:
    min_installs: 5000
    require_clean_scan: true
  auto_install: false  # true lets a trusted, clean match install without asking
  deny_skills: []      # block one skill, even from an otherwise trusted publisher
  deny_publishers: []
```

`deny_skills` takes a full `owner/repo@skill` — for when one skill from a
publisher you otherwise trust shouldn't auto-install. Neither list waives the
scan: a dirty verdict still denies, allowlisted or not.

## When this actually helps

Skills exist for most of these already. The problem is that nobody installs
them until after Claude has botched the task once; metaskill flips the order.

| You type | the skill metaskill finds for you | Instead of |
|---|---|---|
| "Export the numbers to .xlsx with formulas and conditional formatting" | `xlsx` (anthropics) | hand-rolled openpyxl code with broken styling |
| "Pull the totals out of these 40 invoice PDFs" | `pdf` | fragile regex over `pdftotext` output |
| "Turn these notes into a 10-slide investor deck" | `pptx` | an unreadable python-pptx improvisation |
| "Draft the contract as .docx with our heading styles" | `docx` | markdown pasted into Word by hand |
| "Scrape competitor prices into a table" | `scraping` | a crawler with no retries, no politeness, instant 429s |
| "Add Playwright tests for the checkout flow" | a Playwright test-authoring skill | selectors that break on the first re-render |
| "Review the auth flow for SQLi and XSS before release" | `security-review` | a vibes-based review with no checklist |
| "Add meta tags and a sitemap, indexing looks broken" | `seo` | plausible-sounding but outdated SEO advice |
| "Containerize this app properly" | `docker` | a single-stage 2GB image running as root |
| "Pull the deals out of our CRM" | your company's private skill via a policy override | Claude guessing a niche vendor's REST API |

The compounding case: a fresh laptop or a new teammate. Zero setup beyond
`metaskill init`: the first week of real prompts surfaces the same vetted
shortlist for everyone, because the policy (not each person's patience)
decides what is even offered.

Claude never installs any of them on its own. It asks you exactly one
question first:

> The task looks like it needs xlsx charts. Found `foo/bar@xlsx-charts`
> (410 installs, publisher not on your allowlist). Install it? (yes/no)

If there is no suitable skill at all, Claude just solves the task and the gap
is logged: raw material for deciding which skill to write next.

## Install

Requirements: Node ≥ 20, Claude Code, and the `skills` CLI (invoked as
`npx skills`; tested against v1.5.23, run `npx skills --version` once so
it's cached).

**As a plugin (recommended).** Inside Claude Code:

```
/plugin marketplace add xdm/metaskill
/plugin install metaskill@metaskill
```

Claude Code wires up the hooks, the protocol skill and the `/metaskill:*`
commands itself, keeps them updated, and `/plugin uninstall metaskill`
removes everything. Nothing is written to your `settings.json` hooks.

**As a CLI.** Same result without the plugin system — for a project-scoped
setup (`--project`), a version you pin yourself, an environment where plugins
are disabled, or just to get the `metaskill` command on your PATH:

```
npx @xdma/metaskill init
```

`init` is a self-installer, and everything it does is reversible:

- copies its engine to `~/.metaskill/bin/` and points everything at that
  copy — so a plain `npx` init is a permanent setup that survives npx cache
  pruning and node upgrades (re-run init after upgrading);
- registers two hooks in `~/.claude/settings.json` (`--project` targets
  `.claude/settings.json` instead), preserving whatever hooks you already have;
- writes the default policy to `~/.metaskill/metaskill.yaml` (never
  overwritten on re-init);
- installs the `metaskill` protocol skill into `~/.claude/skills/` and the
  `/metaskill:list|log|install|update` commands into `~/.claude/commands/`.

`metaskill init --uninstall` reverses all of it. Installed skills, policy,
log, and lock stay. `npm i -g @xdma/metaskill` is optional — it just puts the
`metaskill` command on your PATH.

Pick one channel: init refuses to run when the plugin is already installed,
so a prompt is never routed twice.

## Commands

```
metaskill init [--project] [--uninstall]
metaskill find "<capability words>"                # local-index lookup; ranks and vets, never installs
metaskill install <owner/repo@skill> [--force]      # policy + scan apply
metaskill update [names...] [--force]
metaskill list                                      # what metaskill installed (alias: ls)
metaskill plugins [words]                           # search plugin marketplaces (suggest only)
metaskill log [-n N] [--stats]                      # routing decisions, or find follow-through
metaskill route                                     # UserPromptSubmit hook body: logs the prompt
metaskill sync [--force]                            # SessionStart hook body: injects the protocol, refreshes the index
```

`--force` bypasses `ask`, never `deny`. With `trust.auto_install` off (the
default) every install is an `ask`, so `--force` is how you record your yes.

## Watching it work

What has metaskill installed so far:

```
$ metaskill list
SKILL  PACKAGE                                 VERSION  MATCHED  INSTALLED   STATUS
xlsx   anthropics/claude-agent-sdk-demos@xlsx  v1.2.3   -        2026-09-02  ok
```

MATCHED is the query phrase that found it. It reads `-` here because this one
came from an approved `install ... --force` — the yes at the end of the
walkthrough above — and a package you named by hand has no matching phrase to
record. Older locks, written when `find` still installed on its own, carry the
phrase that found it.

Why, and what it decided along the way — `route` logs every prompt silently,
`find` logs every lookup:

```
$ metaskill log -n 3
2026-09-02T15:37:28.040Z domains=[] 3ms
2026-09-02T15:37:28.608Z domains=[find:xlsx export formulas] 517ms
2026-09-02T15:37:29.296Z domains=[find:scraping] 606ms
```

The first line is a plain prompt (`route` — it only records that a prompt
happened). The second is the walkthrough's lookup against the full 43,714-skill
index; the third is another `find`. Neither installed anything, because `find`
never does. The log records that a lookup happened, not why — `find`'s own
printed line, and the question it asks you, carry that detail in the moment. `metaskill log --stats` rolls the
whole log up into one number: what share of prompts were actually followed by
a lookup.

State lives in `~/.metaskill/`: `metaskill.yaml` (policy), `skills-lock.json`
(pins), `cache.json` (24h cache of live registry-search results, keyed by
query — used only when a lookup misses the local index), `log.jsonl`
(decisions, 90-day retention), `state.json` (24h sync gate, plus notices
parked for the next session).

## Troubleshooting

- **Nothing prints when I submit a prompt.** That's by design: the
  `UserPromptSubmit` hook (`route`) only records that a prompt happened — it
  never prints anything, so it can never get in your way. Skill discovery
  happens when Claude runs `find` at the start of a task, per the protocol
  injected at session start. `metaskill log` shows both kinds of entry;
  `metaskill log --stats` shows how often a prompt is actually followed by a
  `find`.
- **`find` seems to hang.** It shouldn't for long: a local index hit is fast,
  and the one network fallback (nothing local matches) is capped at 4
  seconds. If the registry itself doesn't answer in time, `find` prints
  `Registry did not answer` — a timeout, not evidence that no skill exists —
  and returns either way; it never blocks your prompt.
- **`metaskill update` refuses a skill, citing "index scan is dirty."** No
  flag bypasses that. It means the local index's own scan found a denied
  pattern in that skill's current source — as of this writing that's true of
  `anthropics/skills@xlsx` (a real `os.environ` read in its script), so if you
  already have it installed, updates will be refused until the registry scans
  it clean again.
- **Install keeps timing out.** Installs get 120 seconds. If one still runs
  out, run it again: `metaskill install <pkg> --force`.
- **Claude found a skill but didn't install it.** That's the default.
  `find` only ranks and vets; Claude asks you before installing, and
  `--force` records the yes. To let trusted, clean matches through
  unattended, set `auto_install: true` under `trust:` in
  `~/.metaskill/metaskill.yaml`.

## Development

```
npm install
npm test          # build + 246 unit/integration tests (stubbed skills CLI, temp HOME)
```

The registry index (`index.json`) is built separately from the CLI and is not
part of `npm test`, since it makes live network calls:

```
npm run build:index   # sweeps skills.sh, scans every repo, writes index.json
```

A scheduled workflow (`.github/workflows/index.yml`) runs this nightly and
publishes the result as the `index-latest` GitHub Release asset, gated on a
minimum description-coverage share and a check against the previously
published record count, so a degraded run never overwrites a good index.

MIT © xdm
