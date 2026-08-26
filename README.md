# metaskill

[![npm](https://img.shields.io/npm/v/%40xdma%2Fmetaskill)](https://www.npmjs.com/package/@xdma/metaskill)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)

Claude Code decides which skills a task needs, installs them safely, then
solves the task. You never search for, compare, or install skills manually.

```bash
npm install -g @xdma/metaskill
metaskill init
```

That's the whole setup. Details, requirements, and uninstall are in
[Install](#install) below.

metaskill is built for **Claude Code only**: it plugs into Claude Code's hook
system (`UserPromptSubmit` / `SessionStart`). Other agents that use skills
(Codex, Cursor, ...) are a v2 goal.

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
and managing skills, done for you.** On every prompt it detects what the task
needs, checks what's already installed, searches the registry for the gap,
vets candidates against your trust policy, installs what passes, and tells
Claude what it now has, all before the model starts answering. You type the
task; the toolkit assembles itself.

```
$ claude
> export the quarterly report to xlsx with formulas and conditional formatting
```

Between pressing Enter and Claude's first token:

1. A `UserPromptSubmit` hook classifies the task → domain `xlsx`.
2. Installed skills are checked. No xlsx skill found.
3. The registry is searched: `anthropics/skills@xlsx`, 158K installs.
4. The trust policy says `anthropics` is allowlisted → installed automatically, version pinned.
5. Claude sees:

```
[metaskill] Domains: xlsx.
Installed now: anthropics/skills@xlsx → ~/.claude/skills/xlsx/SKILL.md
```

and solves the task **with** the skill. Measured on a real machine: ~10s once
per domain (discovery + install), ~3ms on every prompt after that.

## Why it's safe to let an agent install things

An agent that installs packages on its own is the part that should worry you,
so it's the part with the most machinery. Nothing reaches `~/.claude/skills`
because "the model felt like it": every candidate walks a fixed pipeline
(classify → discover → policy decision → static scan → pinned install), and
the model has no say in the decision. The policy file decides.

The decision table, in order, first match wins:

| Condition | Decision |
|---|---|
| publisher in `deny_publishers` | **deny** |
| publisher in `allowlist` (`anthropics`, `vercel-labs` by default) | auto-install |
| static scan found anything | **deny** |
| ≥ 5000 installs **and** scan clean | auto-install |
| anything else | ask the user first |

What backs it up:

- **Static scan before anything is unpacked.** The package's GitHub archive
  goes to a temp dir, and its file tree and contents are checked: hook
  directories, `.mcp.json`, `curl `/`wget `, `eval(`, `process.env`,
  `os.environ`, size limit. Packages that can't be fetched from GitHub can't
  be scanned, so outside the allowlist they can never auto-install.
- **`deny` cannot be bypassed by any flag.** Not `--force`, not anything.
- **The hook never executes skill code.** It downloads, reads, and greps.
  Skills run later, inside Claude, exactly as if you'd installed them by hand.
- **Everything is pinned.** Each install lands in
  `~/.metaskill/skills-lock.json` with source, version, and date. The daily
  auto-update (24h-gated `SessionStart` hook) touches allowlisted publishers
  only.
- **Your prompt stays private.** Registry queries use fixed taxonomy terms
  ("xlsx", "web scraping"), never your prompt text. The log stores a sha256
  of the prompt, not the prompt. The optional LLM classifier (Haiku) runs
  only if `ANTHROPIC_API_KEY` is set; without it, classification is fully
  local heuristics.
- **It fails safe.** On any internal error, registry outage, or timeout, the
  hook exits silently and your prompt proceeds untouched. Installs get 20s;
  on timeout the candidate is downgraded to a question. (Proven during
  development: skills.sh's search API went down; prompts kept working.)
- **When trust is missing, a human decides.** Claude is instructed to ask you
  exactly one question (publisher, install count, why the task needs it) and
  installs only after an explicit yes, via the same policy-checked path.
- **One command to leave.** `metaskill init --uninstall`.

Tune all of it in `~/.metaskill/metaskill.yaml`:

```yaml
trust:
  allowlist: [anthropics, vercel-labs]        # auto-install and auto-update
  auto_threshold:
    min_installs: 5000
    require_clean_scan: true
  deny_publishers: []
domains:                                      # pin a domain to a specific skill
  bitrix24: mycompany/skills@bitrix24-rest
classifier:
  llm: auto                                   # auto | off | always
```

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
| "Add Playwright tests for the checkout flow" | `browser-automation` + `testing` | selectors that break on the first re-render |
| "Review the auth flow for SQLi and XSS before release" | `security-review` | a vibes-based review with no checklist |
| "Add meta tags and a sitemap, indexing looks broken" | `seo` | plausible-sounding but outdated SEO advice |
| "Containerize this app properly" | `docker` | a single-stage 2GB image running as root |
| "Sync deals from Bitrix24" | your own `bitrix24-rest` via a policy override | Claude guessing a niche CRM's REST API |

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

```
npm install -g @xdma/metaskill
metaskill init
```

Requirements: Node ≥ 20, Claude Code, and the `skills` CLI (invoked as
`npx skills`; tested against v1.5.23, run `npx skills --version` once so
it's cached).

`init` does three things, all reversible:

- registers two hooks in `~/.claude/settings.json` (`--project` targets
  `.claude/settings.json` instead), preserving whatever hooks you already have;
- writes the default policy to `~/.metaskill/metaskill.yaml` (never
  overwritten on re-init);
- installs a small `metaskill` protocol skill into `~/.claude/skills/` that
  tells Claude how to read the `[metaskill]` block and when it must ask you;
- adds slash commands to `~/.claude/commands/`, so inside Claude Code you can
  run `/metaskill:list`, `/metaskill:log`, `/metaskill:install <pkg>`, and
  `/metaskill:update` directly (available in new sessions).

`metaskill init --uninstall` removes the hooks and the protocol skill.
Installed skills, policy, log, and lock stay.

Avoid `npx @xdma/metaskill init` for permanent setups: the hook stores an
absolute path to the binary, and npx's cache gets pruned.

## Commands

```
metaskill init [--project] [--uninstall]
metaskill install <owner/repo@skill> [--domain d] [--force]   # policy + scan apply
metaskill update [names...] [--force]
metaskill list                                                # what metaskill installed (alias: ls)
metaskill log [-n N]                                          # routing decisions
metaskill route | sync                                        # hook bodies (stdin JSON)
```

`--force` bypasses `ask`, never `deny`.

## Watching it work

What has metaskill installed so far:

```
$ metaskill list
SKILL  PACKAGE                 VERSION  DOMAIN  INSTALLED   STATUS
xlsx   anthropics/skills@xlsx  -        xlsx    2026-08-26  ok
```

Why, and what it decided along the way:

```
$ metaskill log -n 3
2026-08-26T11:52:56Z domains=[xlsx] installed=[anthropics/skills@xlsx] 10608ms
2026-08-26T11:58:12Z domains=[xlsx] covered=[xlsx] 3ms
2026-08-26T12:03:44Z domains=[scraping] ask:foo/bar@scraper(410,scan=clean) 2410ms
```

State lives in `~/.metaskill/`: `metaskill.yaml` (policy), `skills-lock.json`
(pins), `cache.json` (domain map + 24h discovery cache), `log.jsonl`
(decisions, 90-day retention), `state.json` (sync gate).

## Troubleshooting

- **Nothing happens on a prompt.** Probably classified as trivial (greetings
  and short questions with no action verbs are skipped by design). Check
  `metaskill log`.
- **`skills find` hangs / registry down.** Discovery is capped at 10s per
  domain and falls back to the last cached result; the prompt continues
  either way.
- **Install keeps timing out.** Raise `METASKILL_INSTALL_TIMEOUT_MS`, or
  finish manually: `metaskill install <pkg> --force`.

## Development

```
npm install
npm test          # build + 62 unit/integration tests (stubbed skills CLI, temp HOME)
```

MIT © xdm
