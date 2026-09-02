# metaskill

[![npm](https://img.shields.io/npm/v/%40xdma%2Fmetaskill)](https://www.npmjs.com/package/@xdma/metaskill)
[![skills.sh](https://skills.sh/b/xdm/metaskill)](https://skills.sh/xdm/metaskill)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

Claude Code decides which skills a task needs, installs them safely, then
solves the task. You never search for, compare, or install skills manually.

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
CLI links them into Codex, Cursor and others), but the automatic
"install what this task needs" loop is Claude Code only for now.

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
the registry for the gap, vets the candidate against your trust policy,
installs what passes, and tells Claude what it now has. You type the task;
the toolkit assembles itself.

```
$ claude
> export the quarterly report to xlsx with formulas and conditional formatting
```

Between pressing Enter and Claude's first token:

1. A standing protocol, injected at the start of the session, tells Claude to
   run `metaskill find` before starting any task — this one included.
2. Claude derives a short capability phrase and runs:
   `metaskill find "xlsx export formulas"`.
3. `find` ranks a local index of the registry and gets a hit:
   `anthropics/skills@xlsx`, 158K installs, scan clean.
4. The trust policy says `anthropics` is allowlisted with a clean scan →
   installs automatically, version pinned.
5. `find` prints, and Claude reads it before doing anything else:

```
[metaskill] Installed now: anthropics/skills@xlsx (v1.2.3) -> ~/.claude/skills/xlsx/SKILL.md
Read that SKILL.md and follow it.
```

and solves the task **with** the skill. A local index hit like this is one
fast subprocess call; installing the skill — or, on an index miss, the one
live registry search, capped at 4 seconds — is what actually takes time.

## Why it's safe to let an agent install things

An agent that installs packages on its own is the part that should worry you,
so it's the part with the most machinery. Nothing reaches `~/.claude/skills`
because "the model felt like it": every candidate walks a fixed pipeline
(look up → scan verdict → policy decision → pinned install), and the model
has no say in the decision. The policy file decides.

The decision table, in order, first match wins:

| Condition | Decision |
|---|---|
| skill in `deny_skills`, or its publisher in `deny_publishers` | **deny** |
| scan verdict is `dirty` | **deny** |
| no real install count yet (`estimated`) | ask |
| scan carries an advisory | ask |
| publisher in `allowlist` (`anthropics`, `vercel-labs` by default) | auto-install |
| ≥ 5000 installs **and** scan clean | auto-install |
| anything else | ask the user first |

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
  `~/.metaskill/skills-lock.json` with source, version, and the query that
  found it. The daily auto-update (24h-gated `SessionStart` hook) still
  touches allowlisted publishers only and skips anything the index scans
  dirty; what it did (or skipped, and why) is reported at the start of the
  *next* session, since a hook may only emit one line and the protocol always
  goes out first.
- **The registry index ships in the package and refreshes itself.** A fresh
  install can look skills up offline immediately: the npm package carries a
  trimmed snapshot — the ~4,800 skills with a real install count, about
  0.34 MB gzipped — covering everything the policy could actually auto-install
  on sight. `sync` upgrades that to the full index, currently around 43,585
  skills across 794 repositories, from a nightly GitHub Release, at most once
  every 24 hours. That download is uncompressed and currently about 22.6 MB,
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
  changes nothing. Installs get 20s; on timeout the candidate is downgraded to
  a question rather than left half-installed. The one network fallback (index
  miss → live registry search) is capped at 4s, and a registry that never
  answers prints a distinct `Registry did not answer` line rather than being
  reported as "no skill exists."
- **When trust is missing, a human decides.** Claude is instructed to ask you
  exactly one question (publisher, install count, why the task needs it) and
  installs only after an explicit yes, via the same policy-checked path.
- **Plugins are suggested, never installed.** When a task matches a Claude
  Code plugin from a marketplace you already added, metaskill surfaces it and
  stops there. Plugins can add hooks and MCP servers, so installing one is
  always your call: `metaskill plugins <words>` to browse, `/plugin install`
  to accept.
- **One command to leave.** `metaskill init --uninstall`.

Tune all of it in `~/.metaskill/metaskill.yaml`:

```yaml
trust:
  allowlist: [anthropics, vercel-labs]        # auto-install and auto-update
  auto_threshold:
    min_installs: 5000
    require_clean_scan: true
  deny_skills: []      # block one skill, even from an otherwise trusted publisher
  deny_publishers: []
```

`deny_skills` takes a full `owner/repo@skill` — for when one skill from a
publisher you otherwise trust shouldn't auto-install. Neither list waives the
scan: a dirty verdict still denies, allowlisted or not.

## When this actually helps

Skills exist for most of these already. The problem is that nobody installs
them until after Claude has botched the task once; metaskill flips the order.

| You type | metaskill installs | Instead of |
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
`metaskill init`: the first week of real prompts provisions the same vetted
toolkit for everyone, because the policy (not each person's patience) decides
what gets installed.

And when the top candidate is **not** trusted, Claude doesn't install it. It
asks you exactly one question first:

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
metaskill find "<capability words>"                # local-index lookup; installs on a trusted match
metaskill install <owner/repo@skill> [--force]      # policy + scan apply
metaskill update [names...] [--force]
metaskill list                                      # what metaskill installed (alias: ls)
metaskill plugins [words]                           # search plugin marketplaces (suggest only)
metaskill log [-n N] [--stats]                      # routing decisions, or find follow-through
metaskill route | sync                              # hook bodies: route logs the prompt; sync injects the protocol
```

`--force` bypasses `ask`, never `deny`.

## Watching it work

What has metaskill installed so far:

```
$ metaskill list
SKILL  PACKAGE                 VERSION  MATCHED               INSTALLED   STATUS
xlsx   anthropics/skills@xlsx  v1.2.3   xlsx export formulas  2026-09-02  ok
```

Why, and what it decided along the way — `route` logs every prompt silently,
`find` logs every lookup:

```
$ metaskill log -n 3
2026-09-02T12:51:23.589Z domains=[] 1ms
2026-09-02T12:51:23.645Z domains=[find:xlsx export formulas] installed=[anthropics/skills@xlsx] 26ms
2026-09-02T12:51:23.676Z domains=[find:scraping] 2ms
```

The first line is a plain prompt (`route` — nothing installed, nothing to
show). The second is a `find` that matched locally and auto-installed. The
third is a `find` that didn't install anything; the log records that a lookup
happened, not why — `find`'s own printed line (and the question it asks you,
if any) carries that detail in the moment. `metaskill log --stats` rolls the
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
- **Install keeps timing out.** Raise `METASKILL_INSTALL_TIMEOUT_MS`, or
  finish manually: `metaskill install <pkg> --force`.

## Development

```
npm install
npm test          # build + 175 unit/integration tests (stubbed skills CLI, temp HOME)
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
