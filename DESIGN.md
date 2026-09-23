# Design notes

Why metaskill is shaped the way it is, with the measurements behind each
decision. The code carries a short "why" beside anything non-obvious; this
file holds the longer arguments and the numbers so the code does not have to.

## The standing protocol

`sync` injects one block into every Claude Code session (`src/protocol.ts`).
It replaced a skill file that only loaded when invoked, which nothing ever
invoked: on a log of 244 real prompts the model looked for a skill 8 times.
Everything in the block is there because a softer version was measured
failing:

- **The trigger is "every task", stated as an imperative.** "If a skill could
  help" is a question the model answers "no", because its honest prior is
  that it can do the task itself.
- **When to ask is a rule with a number in it, and `find` applies it.** Left
  to prose, the same question was relayed at relevance 0.08 and at 1.58
  alike. Left to a middle band ("decide whether it fits, then ask"), five
  real lookups in a row produced no question, four of them wrongly. A slot
  that permits skipping is used to skip, so there are two zones and no slot.
- **The one silence above the line is the description check.** A lexical
  score ranks a rare word's wrong sense highest: "insomnia help" finds a REST
  client called Insomnia, "stress management" finds a load tester. On a
  47-query probe of everyday tasks, 72% of rows clearing the threshold were
  homonyms of this kind. The model can tell from the description; BM25
  cannot. So the rule says: read the description, then ask or say nothing.
- **Asking means first, as a real question.** A question printed at the end
  of an answer that had already begun was not experienced as a question. The
  block names the AskUserQuestion tool, with a one-line text fallback.
- **A no has a command too.** With only the yes recorded, one package was put
  to the same user on twelve consecutive mornings. `decline` records the no
  for 30 days and `find` hides the package.
- **The block is budgeted** (under 1400 chars of prose, under 1600 injected,
  enforced by tests). It is read once per session by every user; each
  sentence has to earn its place, and a new one is paid for by cutting.

## The relevance threshold

`find` ranks the local index with BM25 and prints, per row, the score as a
fraction of the best score the query could reach. That ratio is comparable
across index sizes; raw BM25 is not.

`MIN_ASK_RELEVANCE = 0.55` decides what prints under the rows. Measured
against the packaged snapshot on 52 queries (47 everyday tasks plus 5 real
ones), share of top rows reaching each candidate threshold:

| T    | deserving | undeserving | deserving real |
|------|-----------|-------------|----------------|
| 0.45 | 85%       | 85%         | 4/4            |
| 0.50 | 77%       | 77%         | 4/4            |
| 0.55 | 77%       | 72%         | 4/4            |
| 0.60 | 62%       | 59%         | 3/4            |
| 0.70 | 54%       | 33%         | 2/4            |

0.55 is the highest value that still admits every real query that deserved a
question (their minimum was 0.56); at 0.45 the two curves meet, so the
threshold has stopped discriminating. No threshold separates homonyms from
real matches, which is why the description check sits above the line rather
than being folded into it.

## One record per skill

Two aggregator repositories mirror about 12,800 skills from hundreds of
origins, and popular repositories are forked whole. Measured on one nightly
index, 11,818 of 44,573 records were exact copies (same name, same
description) of another record; ranked, they stacked, and the row the user
was asked about was whichever copy the tokeniser favoured.

The build keeps one record per name + description. The survivor is the copy
with the higher real install count, then the one from the repository that
shares skills with the fewest other repositories, then the first source name.
Install count comes first because it is what keeps a heavily mirrored origin
intact: a provenance-first rule read "shared with many repositories" as
"mirror" and dropped 8 of anthropics/skills' 20 records. On the 57 real
queries of a two-week log, top rows from the two aggregators fell from 6 to 2.

An earlier idea, excluding aggregator repositories by a rule on
registry-unknown share and duplicate names, was measured dropping 33
repositories including official vendor ones, because the registry only knows
skills people have installed through its CLI. It was not adopted.

## Package names

A record's package name ends in the skills CLI's install name, not the raw
frontmatter name. The CLI matches `owner/repo@<selector>` against a sanitised
form (lowercase, runs outside `[a-z0-9._]` become one dash, edge dots and
dashes dropped) and installs into a directory of that name. The two strings
are equal for the ordinary name, which hid the difference until 345 records
with spaces or capitals produced commands that split in the shell.

## Trust policy

`find` ranks and prints; `install` enforces policy; nothing reaches disk
without the user's yes unless `trust.auto_install` is set. The decision table
(`src/policy.ts`) puts a dirty scan and an estimated install count ahead of
the allowlist: a trusted publisher's repository can still be compromised, and
an estimated count is a guess. The allowlist waives the install-count
threshold and nothing else; a `deny` cannot be bypassed by any flag.

Content-pattern hits in prose (a README that documents `curl`) are
advisories, not denials: measured over the registry, 66% of dirty verdicts
came only from a pattern in documentation.

## What the log measures

`route` logs one row per prompt; `find`, `install` and `decline` log their
own rows. `log --stats` prints follow-through (the share of prompts followed
by a lookup; 3% before the injected protocol, 10–17% after) and the number
of questions that were answered (installs plus declines), which the ratio
alone cannot see.

## The index

A nightly CI job sweeps the registry with two-letter queries (its search
endpoint caps responses at 100 and rate-limits at 30 requests a minute),
reads every repository's SKILL.md files from one archive download, scans
them, and publishes the result as a GitHub Release asset. A publish gate
refuses an index whose description coverage or record count collapsed, so a
degraded run never overwrites a good one; the count is compared after the
same deduplication on both sides. `sync` downloads it daily; the npm package
ships a snapshot of the registry-known subset as the offline floor.
