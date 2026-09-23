import { loadIndex, MIN_ASK_RELEVANCE, normaliseQuery, scanResultFromIndex, search } from "../index/read.js";
import { metaskillCmd } from "../paths.js";
import type { IndexRecord } from "../index/types.js";
import { activeDeclines } from "../declines.js";
import { discoverByQuery, publisherOf } from "../discover.js";
import { listInstalledSkills } from "../inventory.js";
import { readLock } from "../lock.js";
import { findPlugins, formatPluginLine } from "../plugins.js";
import { decide, loadPolicy } from "../policy.js";
import { appendLog, hashPrompt } from "../log.js";
import type { Candidate, DiscoveredLogItem, InstalledSkill } from "../types.js";

export function recordToCandidate(r: IndexRecord): Candidate {
  return {
    pkg: r.pkg,
    publisher: publisherOf(r.pkg),
    skillName: r.name,
    installs: r.installs ?? r.installsPrior ?? 0,
    url: "",
    estimated: r.estimated,
  };
}

// Reinstall protection. Equality only, never "a query word appears in the
// name": containment matched `code review` to an installed `codebase-memory`
// and handed the model an unrelated SKILL.md. Two exact forms count: the
// installed skill's name is the query (spaces as hyphens), or the lock says
// this exact phrase is what installed it (`install --matched`).
function alreadyPresent(q: string, installed: InstalledSkill[]): InstalledSkill | undefined {
  const hyphenated = q.replace(/ /g, "-");
  const byName = installed.find((s) => s.name.toLowerCase() === hyphenated);
  if (byName) return byName;
  let lock;
  try {
    lock = readLock();
  } catch {
    return undefined; // a corrupt lock costs the shortcut, never the command
  }
  const matched = Object.values(lock).find((e) => e.domain === q);
  return matched ? installed.find((s) => s.name === matched.skill) : undefined;
}

// A blank description, or a bare YAML block marker left where one should be,
// gives the model nothing to check the fit against. Such a row still ranks
// (on its name), so it is stepped over rather than asked about.
const BARE_BLOCK_MARK = /^[>|][+-]?$/;
function descriptionUnreadable(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  return d.length === 0 || BARE_BLOCK_MARK.test(d);
}

// `~N est` marks a count guessed from sibling skills; without the mark it
// would reach the user as a fact.
function installsLabel(r: IndexRecord): string {
  return r.installs === null ? `~${r.installsPrior ?? 0} est` : String(r.installs);
}

function line(r: IndexRecord, relevance: number, decision: string, reason: string): string {
  const desc = (r.description ?? "").replace(/\s+/g, " ").slice(0, 140);
  return `  ${r.pkg} (${installsLabel(r)} installs, scan=${r.scan}, relevance=${relevance.toFixed(2)}) [${decision}: ${reason}]\n    ${desc}`;
}

// The question is written out in full so the model relays it instead of
// composing one; a question it has to compose is one it tends not to ask. The
// facts in it are the row's own, so the user can check them against the row.
function questionLine(pkg: string, installs: string, publisher: string, scan: string): string {
  return `Ask the user: Install ${pkg} (${installs} installs, publisher ${publisher}, scan ${scan}) for this task? yes/no`;
}

// Run by the in-session model from a printed command, so every path ends in
// printed lines and exit 0 — never a stack trace.
export async function findCommand(query: string, opts: { index?: string } = {}): Promise<number> {
  const t0 = Date.now();
  try {
    const policy = loadPolicy();
    const q = normaliseQuery(query);
    if (q.length < 3) {
      process.stderr.write('usage: metaskill find "<capability words>"\n');
      return 2;
    }

    // `discovered` is stated at every call site: a row that says nothing
    // about what was found reads as "found nothing".
    const logFind = (covered: string[], discovered: DiscoveredLogItem[]) =>
      appendLog(
        {
          ts: new Date().toISOString(),
          session: "find",
          prompt_hash: hashPrompt(`find:${q}`),
          domains: [`find:${q}`],
          covered,
          discovered,
          installed: [],
          latency_ms: Date.now() - t0,
        },
        policy,
      );

    const pluginHit = findPlugins(q, 1)[0];
    const pluginLine =
      pluginHit && !pluginHit.installed
        ? `[metaskill] ${formatPluginLine(pluginHit)} — ask the user before installing it; on yes: /plugin install ${pluginHit.name}@${pluginHit.marketplace}\n`
        : "";

    const present = alreadyPresent(q, listInstalledSkills(process.cwd()));
    if (present) {
      process.stdout.write(`[metaskill] Already present: ${present.name} — use ${present.dir}/SKILL.md\n${pluginLine}`);
      logFind([present.name], []);
      return 0;
    }

    // Packages the user said no to (declines.ts) are removed from both
    // branches before anything is asked about, kept as log items marked
    // `declined`, and named under the list so their absence is explained.
    const declined = activeDeclines();
    const hidden: DiscoveredLogItem[] = [];
    const notDeclined = <T>(xs: T[], toItem: (x: T) => DiscoveredLogItem): T[] =>
      xs.filter((x) => {
        const item = toItem(x);
        if (!(item.pkg in declined)) return true;
        if (!hidden.some((h) => h.pkg === item.pkg)) hidden.push(item);
        return false;
      });
    const declinedBlock = (): string =>
      hidden.map((h) => `Declined earlier, not offered: ${h.pkg} (until ${declined[h.pkg]!.until.slice(0, 10)})\n`).join("");
    const declineLine = (pkg: string): string => `On no run: ${metaskillCmd()} decline ${pkg} --matched "${q}"\n`;

    const index = loadIndex(opts.index);
    // Ask for extra rows so a hidden package never shortens the list.
    const declinedCount = Object.keys(declined).length;
    let hits = index
      ? notDeclined(search(index, q, 5 + declinedCount), (h) => ({
          pkg: h.record.pkg,
          installs: h.record.installs ?? h.record.installsPrior ?? 0,
          publisher: publisherOf(h.record.pkg),
          decision: "declined",
          scan: scanResultFromIndex(h.record).status,
        })).slice(0, 5)
      : [];

    // Every local match declined: the live search would only find the same
    // packages again.
    if (!hits.length && hidden.length) {
      process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${declinedBlock()}${pluginLine}`);
      logFind([], hidden);
      return 0;
    }

    // Long tail: the index is a snapshot, so fall back to one live search.
    if (!hits.length) {
      // 4s: the model waits on this call at the start of every task, and
      // registry latency drifts (2-3s warm, with a tail past 4s at any
      // budget). Longer waits are what teach a model to stop running the
      // command; the tail is why `Registry did not answer` exists.
      let liveFailed = false;
      const cands = notDeclined(
        await discoverByQuery(q, {
          timeoutMs: 4_000,
          onFailure: () => {
            liveFailed = true;
          },
        }),
        (c) => ({ pkg: c.pkg, installs: c.installs, publisher: c.publisher, decision: "declined", scan: "unavailable" }),
      );
      if (!cands.length) {
        // A timeout is not evidence that no skill exists.
        if (liveFailed) {
          process.stdout.write(
            `[metaskill] Registry did not answer for "${q}" — this is not a miss. Solve the task without a skill, or run find once more.\n${pluginLine}`,
          );
          logFind([], []);
          return 0;
        }
        process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${declinedBlock()}${pluginLine}`);
        logFind([], hidden);
        return 0;
      }
      const top = [...cands].sort((a, b) => b.installs - a.installs)[0]!;
      // A live hit has no relevance and no scan verdict, so it is always
      // `ask`, and it gets the same printed question as the local branch.
      process.stdout.write(
        `[metaskill] Not in the local index; live search found ${top.pkg} (${top.installs} installs).\n` +
          `${questionLine(top.pkg, String(top.installs), top.publisher, "unavailable")}\n` +
          `On the user's explicit yes run: ${metaskillCmd()} install ${top.pkg} --force --matched "${q}"\n` +
          `${declineLine(top.pkg)}${declinedBlock()}${pluginLine}`,
      );
      logFind([], [{ pkg: top.pkg, installs: top.installs, publisher: top.publisher, decision: "ask", scan: "unavailable" }, ...hidden]);
      return 0;
    }

    // Code ranks, the model picks, `install` enforces policy. Nothing here
    // installs, whatever the decision column says.
    const rows = hits.map((h) => {
      const scan = scanResultFromIndex(h.record);
      const v = decide(recordToCandidate(h.record), scan, policy);
      return { r: h.record, rel: h.relevance, v, scan };
    });

    // Logged in the order printed (askable rows, then the refused block), so
    // the log lines up with the screen.
    const toDiscovered = (x: (typeof rows)[number]): DiscoveredLogItem => ({
      pkg: x.r.pkg,
      installs: x.r.installs ?? x.r.installsPrior ?? 0,
      publisher: publisherOf(x.r.pkg),
      decision: x.v.decision,
      scan: x.scan.status,
    });

    // Denied rows get their own block with no command under it: no flag
    // installs them, so a question about one is a wasted turn.
    const askable = rows.filter((x) => x.v.decision !== "deny");
    const denied = rows.filter((x) => x.v.decision === "deny");
    const deniedBlock = denied.length
      ? `Refused by policy — no flag installs these, do not offer them:\n` +
        denied.map((x) => line(x.r, x.rel, x.v.decision, x.v.reason)).join("\n") +
        "\n"
      : "";
    if (!askable.length) {
      process.stdout.write(
        `[metaskill] No skills found for "${q}". Solve the task without one.\n${deniedBlock}${declinedBlock()}${pluginLine}`,
      );
      logFind([], [...[...askable, ...denied].map(toDiscovered), ...hidden]);
      return 0;
    }
    // The line under the rows is about the best row the user could still say
    // yes to — a denied row can outrank it, and must not decide for it.
    const top = askable[0]!;
    const atT = askable.filter((x) => x.rel >= MIN_ASK_RELEVANCE);
    // The first row above the threshold whose description can be read. An
    // unreadable row retires itself, not the query: registry sources that
    // report installs and nothing else put such rows on top of real matches.
    const chosen = atT.find((x) => !descriptionUnreadable(x.r.description));
    const asked = chosen && chosen.v.decision === "ask" ? chosen : undefined;
    // When the fallback fired, say so: a line about the second row under a
    // list whose first row scores higher looks like a bug otherwise.
    const skipped = chosen && atT[0] !== chosen ? atT[0] : undefined;
    const skippedCount = chosen ? atT.indexOf(chosen) : 0;
    const skipHead = skipped
      ? skippedCount === 1
        ? `${skipped.r.pkg} ranked higher (${skipped.rel.toFixed(2)}) but its description is blank or a bare mark ` +
          `(\`>\`, \`|\`)`
        : `${skippedCount} rows ranked higher, from ${skipped.r.pkg} (${skipped.rel.toFixed(2)}) down, but their ` +
          `descriptions are blank or bare marks (\`>\`, \`|\`)`
      : "";
    const skipClause = skipped ? ` — ${skipHead}, so this question is about the next readable row` : "";
    const skipClauseAuto = skipped ? ` — ${skipHead}, so the command below is about the next readable row` : "";
    // Two zones on MIN_ASK_RELEVANCE. Above the line the only silence is the
    // description check — a yes/no about text on the row that catches the
    // homonyms a lexical score ranks highest (`insomnia help` -> a REST
    // client). The cue prints above the question, so it is read first.
    const askCue = (rel: number): string =>
      `Likely fit (relevance ${rel.toFixed(2)})${skipClause} — read the row's description first: if it fits the ` +
      `task, ask the question below, first, via the tool if you have it; if it is a different thing with the same ` +
      `word, say nothing and solve the task; if the description is blank or a bare mark (\`>\`, \`|\`), you cannot ` +
      `confirm the fit — say nothing and solve the task.\n`;
    // Above the line with nothing readable: no question and no install
    // command, and the cue says why — a model that expects a question and
    // finds none composes its own.
    const unreadableCue = (rel: number, pkg: string): string =>
      `Likely fit (relevance ${rel.toFixed(2)}) — but ${pkg}'s description is blank or a bare mark (\`>\`, \`|\`): ` +
      `nothing here can confirm the fit, so no question is printed. Say nothing and solve the task.\n`;
    // `trust.auto_install` is a standing yes to the question, not to the
    // description check: policy reads a publisher, a count and a scan verdict,
    // none of which can see a homonym. So the same cue, then the concrete
    // command (no `--force`: the knob is the yes; no `<pkg>` placeholder: the
    // model runs commands as printed).
    const autoCue = (rel: number): string =>
      `Likely fit (relevance ${rel.toFixed(2)})${skipClauseAuto} — read the row's description first: if it fits ` +
      `the task, run the command below; if it is a different thing with the same word, run nothing, say nothing ` +
      `and solve the task.\n`;
    const autoLine = (x: (typeof askable)[number]): string =>
      `Policy allows this without asking — run: ${metaskillCmd()} install ${x.r.pkg} --matched "${q}"\n`;
    const verdictLine = !atT.length
      ? `Weak matches only (top relevance ${top.rel.toFixed(2)}) — solve the task yourself, silently.\n`
      : !chosen
        ? unreadableCue(top.rel, top.r.pkg)
        : asked
          ? askCue(asked.rel) +
            `${questionLine(asked.r.pkg, installsLabel(asked.r), publisherOf(asked.r.pkg), asked.r.scan)}\n`
          : autoCue(chosen.rel) + autoLine(chosen);
    // The install and decline commands print only under a question: under
    // "solve the task yourself" an install command is an invitation to
    // ignore that sentence. `--matched` carries the query into the lock so
    // a repeat of it short-circuits in alreadyPresent.
    const installLine = !asked
      ? ""
      : `Install only on the user's explicit yes: ${metaskillCmd()} install ${asked.r.pkg} --force --matched "${q}"\n` +
        declineLine(asked.r.pkg);
    process.stdout.write(
      // The header states the rule and points at the line that applied it;
      // it asks the model to weigh nothing. The threshold is interpolated so
      // it cannot drift from MIN_ASK_RELEVANCE.
      `[metaskill] Top matches for "${q}" — find does not install. The line under the rows has applied these rules to ` +
        `the top row you could install: \`Ask the user:\` (relevance >= ${MIN_ASK_RELEVANCE.toFixed(2)}) — read ` +
        `that row's description; if it is a different thing with the same word, or has no description, say nothing and ` +
        `solve the task; otherwise ask that question FIRST, before any work; \`Weak matches only\` (under ` +
        `${MIN_ASK_RELEVANCE.toFixed(2)}) — solve the task yourself, silently; \`Policy allows this without asking\` ` +
        `(you set \`trust.auto_install\`) — no question to put: read that row's description, then run the command ` +
        `that line names.\n` +
        askable.map((x) => line(x.r, x.rel, x.v.decision, x.v.reason)).join("\n") +
        `\n${verdictLine}${installLine}${deniedBlock}${declinedBlock()}${pluginLine}`,
    );
    logFind([], [...[...askable, ...denied].map(toDiscovered), ...hidden]);
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] find error: ${(err as Error).message}\n`);
    return 0;
  }
}
