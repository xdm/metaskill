import { loadIndex, MIN_ASK_RELEVANCE, normaliseQuery, scanResultFromIndex, search } from "../index/read.js";
import { metaskillCmd } from "../paths.js";
import type { IndexRecord } from "../index/types.js";
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

// Reinstall protection, deliberately narrow. It used to ask whether ANY word
// of the query (>=3 chars) appeared anywhere inside an installed skill's
// name, which with only `codebase-memory` installed answered both `find "code
// review"` and `find "memory profiling"` with "Already present:
// codebase-memory" — suppressing the index lookup and handing the model an
// unrelated SKILL.md to follow. The false-positive rate grows with every
// skill installed, so the test is now equality, not containment:
//
//   (i)  an installed skill whose name IS the query (spaces -> hyphens), or
//   (ii) the lock recording this exact phrase as the phrase that installed it
//        (LockEntry.domain) — written by `install --matched "<q>"`, using the
//        same normaliser this file's `q` already went through, so a repeat of
//        the phrase that found a skill short-circuits here next time. `find`
//        itself still never installs and never writes the lock; it only
//        reads this field, which is also why locks written by an earlier
//        version (before `install` recorded it) still short-circuit too.
//
// Anything else goes to the index. The cost of being wrong in this direction
// is one extra local lookup; the cost in the other direction was the model
// reading the wrong skill.
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

// The one test for "this row's description tells the reader nothing", used by
// the cue's wording, by the fallback that steps past such a row, and by the
// gate that suppresses the question when nothing readable is left — one
// function, so the sentence on screen and the lines printed beneath it can
// never disagree about the same row.
//
// 129 of the regenerated snapshot's 4,835 records land here (2.67%), down
// from 900 before the frontmatter parser was fixed. What remains is a
// different population: non-`owner/repo` registry sources (open.feishu.cn,
// code.deepline.com, skills.volces.com, docs.stripe.com, smithery.ai) that
// report hard install counts — so the snapshot's `installs !== null` filter
// keeps them — and carry no description at all. They still rank, on the skill
// NAME alone, which is exactly how a name-shaped match reaches a high
// relevance with nothing behind it: `linkedin outreach prospecting` puts
// code.deepline.com@portfolio-prospecting (25,096 installs, no description)
// on top. This is the runtime refusing to act on data it cannot read.
const BARE_BLOCK_MARK = /^[>|][+-]?$/;
function descriptionUnreadable(description: string | null | undefined): boolean {
  const d = (description ?? "").trim();
  return d.length === 0 || BARE_BLOCK_MARK.test(d);
}

// Shared by the row and the question printed under it, so the two can never
// disagree about a count the user is being asked to weigh. `~N est` is a
// prior guessed from sibling skills; dropped, it would reach the user as a
// fact.
function installsLabel(r: IndexRecord): string {
  return r.installs === null ? `~${r.installsPrior ?? 0} est` : String(r.installs);
}

// `relevance` is printed because the model, not the code, now picks which row
// (if any) answers the task. BM25 cannot tell whether "say hello" is really
// about a greeting skill; it only reports how much of the query the row
// matched, and 0.00-1.x is the one number that says so comparably across
// index sizes. A reader who sees every row at 0.4 has been told what a
// hard-coded floor used to decide for them, and can still see the rows.
function line(r: IndexRecord, relevance: number, decision: string, reason: string): string {
  const desc = (r.description ?? "").replace(/\s+/g, " ").slice(0, 140);
  return `  ${r.pkg} (${installsLabel(r)} installs, scan=${r.scan}, relevance=${relevance.toFixed(2)}) [${decision}: ${reason}]\n    ${desc}`;
}

// The question, written out, for the top row the user could still say yes to.
//
// The block used to end at the rows and the install command, which left the
// model to compose the question itself — and on the first real v2 lookup it
// composed nothing: five `ask` rows, a plainly fitting top row at relevance
// 1.16, and no question asked. Asking costs a turn and the output handed it
// nothing ready to say, so the cheapest reading of the rows ("none of these
// fits") won. Handing over the finished sentence is the same move that
// made the install command work: the model relays a string instead of
// deciding how to phrase one.
//
// The three facts in it are the ones SKILL.md has always required of the
// question — package, install count, publisher — plus the scan verdict,
// because a row's `ask` usually rests on one of those two numbers and the
// user answering deserves to see what it rests on. They are the row's own
// values, in the row's own format: a question quoting a number the row above
// it does not show is a question the user cannot check.
//
// Plain fields, not an IndexRecord, because the live-fallback branch has no
// record — only a Candidate — and the protocol promises the model a printed
// question on BOTH branches. One function, one sentence shape.
//
// `Ask the user:` is now the label on EVERY question this command prints.
// There used to be a second, label-less form for the middle band, on the
// grounds that a row that had to be weighed first should not be handed a
// relay-this cue. The band is gone (see MIN_ASK_RELEVANCE): at or above the
// threshold there is one instruction, and it is the same instruction on every
// row that reaches it.
function questionLine(pkg: string, installs: string, publisher: string, scan: string): string {
  return `Ask the user: Install ${pkg} (${installs} installs, publisher ${publisher}, scan ${scan}) for this task? yes/no`;
}

// find is invoked directly by the in-session model via Bash, with no human
// watching and no hook-safe-exit entry in cli.ts's uncaught handler — so
// unlike a thrown error surfacing as `metaskill: <stack>` and exit 1, every
// path through here must degrade to a single printed line and exit 0.
export async function findCommand(query: string, opts: { index?: string } = {}): Promise<number> {
  const t0 = Date.now();
  try {
    const policy = loadPolicy();
    const q = normaliseQuery(query);
    if (q.length < 3) {
      process.stderr.write('usage: metaskill find "<capability words>"\n');
      return 2;
    }

    // `installed` is always empty: find ranks, it does not install. The field
    // stays in the record because `log --stats` and older log lines share the
    // shape, and `install` may still write a non-empty one.
    //
    // `discovered` is required, not defaulted to `[]`, on purpose (task 14):
    // a log row used to carry `discovered: []` unconditionally, so a user
    // reading `domains=[find:linkedin post copywriting] 54ms` on its own had
    // no way to tell "found nothing" from "found five and asked" — the first
    // question anyone reading the log actually has. Every call site below now
    // states its own answer instead of inheriting a silent default.
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

    // Reinstall protection: an installed skill the query names exactly answers
    // it without touching the index or the network.
    const present = alreadyPresent(q, listInstalledSkills(process.cwd()));
    if (present) {
      process.stdout.write(`[metaskill] Already present: ${present.name} — use ${present.dir}/SKILL.md\n${pluginLine}`);
      logFind([present.name], []);
      return 0;
    }

    const index = loadIndex(opts.index);
    let hits = index ? search(index, q, 5) : [];

    // Long tail: the index is a snapshot, so fall back to one live search.
    if (!hits.length) {
      // 4s, not discoverRaw's 10s default. The protocol now tells the model to
      // run `find` at the start of EVERY task, and most of those miss the local
      // index and land here. Ten silent seconds, several times a session, is
      // what teaches a model to quietly stop obeying a standing instruction —
      // the same ending as never running it at all. The live call itself stays
      // (spec §6 mandates it for the long tail); only the budget shrinks, and
      // only on this path. route.ts keeps the 10s default: it runs once per
      // prompt with no model waiting on the result.
      //
      // 4s is margin over a median that moves, not a threshold with a right
      // answer. `npx -y skills@1.5.23 find` measured 2.86 / 3.06 / 3.08s warm
      // on one day and 2.0-2.5s on another; registry latency is bimodal and
      // drifts, and on the second day roughly one call in six exceeded the
      // budget at 3s AND at 4s alike. So 4s does not rescue a dead path — it
      // buys headroom over a latency nobody controls, while staying far below
      // the 10s that made a model give up on the protocol. Do not round it
      // back to 3 (less margin, same tail) or up to 10 (the wait is the thing
      // being fixed), and re-measure rather than reasoning about it.
      //
      // The tail never goes to zero at any budget, which is exactly why the
      // `Registry did not answer` branch below exists: whatever the timeout,
      // some calls will not come back, and that fact must not reach the model
      // disguised as "no such skill exists".
      let liveFailed = false;
      const cands = await discoverByQuery(q, {
        timeoutMs: 4_000,
        onFailure: () => {
          liveFailed = true;
        },
      });
      if (!cands.length) {
        // A lookup that never answered is not the same fact as a registry that
        // answered "nothing". Printing `No skills found` for both would have
        // the model tell the user no skill exists on the strength of a timeout.
        if (liveFailed) {
          process.stdout.write(
            `[metaskill] Registry did not answer for "${q}" — this is not a miss. Solve the task without a skill, or run find once more.\n${pluginLine}`,
          );
          logFind([], []);
          return 0;
        }
        process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${pluginLine}`);
        logFind([], []);
        return 0;
      }
      const top = [...cands].sort((a, b) => b.installs - a.installs)[0]!;
      // A registry hit carries no relevance — there is no ranked list to
      // place it in — so the bands below cannot apply to it, and it is always
      // askable (no scan verdict means `ask`, whatever else is true). It
      // therefore always gets its question, written out the same way as the
      // local branch's: the protocol tells the model to relay a printed
      // `Ask the user:` line, and a branch that printed none would teach it
      // that the promise is unreliable.
      process.stdout.write(
        `[metaskill] Not in the local index; live search found ${top.pkg} (${top.installs} installs).\n` +
          `${questionLine(top.pkg, String(top.installs), top.publisher, "unavailable")}\n` +
          // Same --matched carry as the local-index branch below: whichever
          // path led to this confirmed install, the lock should end up with
          // the phrase that found it, or alreadyPresent's short-circuit only
          // works for half of `find`'s outcomes.
          `On the user's explicit yes run: ${metaskillCmd()} install ${top.pkg} --force --matched "${q}"\n${pluginLine}`,
      );
      // The live registry never returns a scan verdict (spec §10 open
      // question, task 14 self-review's known gap) — "unavailable" is a fact
      // about the fallback path, not a guess, and `decide()` would route an
      // unscanned candidate to `ask` regardless, so hard-coding it here
      // matches what policy would compute without paying for a scan nobody
      // asked for.
      logFind([], [{ pkg: top.pkg, installs: top.installs, publisher: top.publisher, decision: "ask", scan: "unavailable" }]);
      return 0;
    }

    // Code ranks; the model picks; `install` enforces policy (spec §4.4).
    // This used to end in "the top-ranked BM25 hit installs itself", which is
    // the step that produced unattended installs on junk queries — BM25 can
    // report how much of a query a row matched, it cannot tell whether the
    // row answers the task, and the one reader that can was cut out of the
    // loop. So `find` prints and stops. Nothing here installs, whatever the
    // decision column says; `trust.auto_install: true` re-arms the automatic
    // path, and even then it is `install` that acts on it, never this command.
    const rows = hits.map((h) => {
      const scan = scanResultFromIndex(h.record);
      const v = decide(recordToCandidate(h.record), scan, policy);
      return { r: h.record, rel: h.relevance, v, scan };
    });

    // One DiscoveredLogItem per row, in STDOUT order — askable rows in rank
    // order, then the refused block — not in search()'s rank order. The two
    // differ whenever a denied row outranks an askable one, and the log is
    // read by a human lining it up against what they just saw on screen; rank
    // order would hand them a sequence that appeared nowhere. `scan` reuses
    // scanResultFromIndex's status rather than re-deriving the unknown ->
    // unavailable mapping a second time.
    const toDiscovered = (x: (typeof rows)[number]): DiscoveredLogItem => ({
      pkg: x.r.pkg,
      installs: x.r.installs ?? x.r.installsPrior ?? 0,
      publisher: publisherOf(x.r.pkg),
      decision: x.v.decision,
      scan: x.scan.status,
    });

    // Denied rows never appear under the ask header. Listed there, above a
    // line reading `install <pkg> --force`, they read as an invitation to go
    // get approval for a package policy has already refused — and no flag
    // installs them, so the only possible outcome was a wasted question and a
    // failed command. They keep their own block, with no command under it.
    const askable = rows.filter((x) => x.v.decision !== "deny");
    const denied = rows.filter((x) => x.v.decision === "deny");
    const deniedBlock = denied.length
      ? `Refused by policy — no flag installs these, do not offer them:\n` +
        denied.map((x) => line(x.r, x.rel, x.v.decision, x.v.reason)).join("\n") +
        "\n"
      : "";
    if (!askable.length) {
      // Every match refused. `No skills found` is the branch the protocol and
      // SKILL.md already tell the model how to act on (solve it yourself);
      // inventing a label for this case would leave it improvising.
      process.stdout.write(
        `[metaskill] No skills found for "${q}". Solve the task without one.\n${deniedBlock}${pluginLine}`,
      );
      logFind([], [...askable, ...denied].map(toDiscovered)); // askable is empty here: stdout order is the refused block
      return 0;
    }
    // The row the line under the rows is about, before the two things that
    // can retire it — not simply `rows[0]`. A denied row can outrank every
    // askable one, and letting it decide would refuse to act on a package
    // policy is willing to install because a different package is not.
    const top = askable[0]!;
    // Every row the line could be about, in rank order: askable rows at or
    // above the threshold, whatever policy decided about them. `relevance`
    // divides every score for one query by the same constant, so this is a
    // prefix of `askable`, its first element IS `top` whenever anything
    // clears the line, and it is empty exactly when nothing does.
    const atT = askable.filter((x) => x.rel >= MIN_ASK_RELEVANCE);
    // The row the printed line is about: the highest-ranked one at or above
    // the threshold that has a description to read.
    //
    // The fallback is not a nicety. `linkedin outreach prospecting` — one of
    // the five real 2026-09-04 queries — puts code.deepline.com@portfolio-
    // prospecting on top at 0.66 with NO description (a registry source that
    // reports installs and nothing else), and a genuine match one row down.
    // Before this, the unreadable top row silenced the whole command: the cue
    // said "nothing here can confirm the fit" while a readable, askable,
    // above-threshold row sat directly beneath it, printed but unmentioned.
    // The check that suppresses a question is about ONE row's evidence, so it
    // must retire that row, not the query. It spans `auto` rows too: with the
    // knob on, a row nobody can describe reaches `auto` on installs alone
    // (>= min_installs and a clean scan is enough — see policy.ts), and
    // code.deepline.com@portfolio-prospecting, 25,096 installs and no
    // description, is exactly that row. "Install this without asking" is the
    // last sentence that should print about text nobody can read.
    const chosen = atT.find((x) => !descriptionUnreadable(x.r.description));
    // The row a QUESTION is printed about — the same row, unless policy has
    // already cleared it, in which case there is nothing to ask. It drives
    // the install command below, so the command and the question cannot name
    // different packages.
    const asked = chosen && chosen.v.decision === "ask" ? chosen : undefined;
    // Named in the line when the fallback fires, because a line about the
    // second row under a list whose first row scores higher looks like a bug
    // unless the output says why. One clause, not a paragraph — and one per
    // outcome, written out rather than spliced from a shared head, because
    // the asking line's clause ends in "this question" and the policy line
    // asks nothing.
    const skipped = chosen && atT[0] !== chosen ? atT[0] : undefined;
    const skipClause = skipped
      ? ` — ${skipped.r.pkg} ranked higher (${skipped.rel.toFixed(2)}) but its description is blank or a bare mark ` +
        `(\`>\`, \`|\`), so this question is about the next row down`
      : "";
    const skipClauseAuto = skipped
      ? ` — ${skipped.r.pkg} ranked higher (${skipped.rel.toFixed(2)}) but its description is blank or a bare mark ` +
        `(\`>\`, \`|\`), so the command below is about the next row down`
      : "";
    // Two zones, and the only silence above the line is a check the model can
    // make and BM25 cannot.
    //
    // The middle band is gone. "0.5-1.0: decide whether the row fits, then
    // ask" was the last place the model got to rule on whether to
    // ask at all — and on 2026-09-04 all five of the user's real `find` calls
    // landed in it and produced no question, four of them wrongly. A slot
    // that permits skipping is used to skip; three review rounds said so.
    // MIN_ASK_RELEVANCE carries the measurement that replaced it.
    //
    // What stays above the line is not that discretion returning. "Which row,
    // if any, is worth asking about" is a question about the model's own
    // appetite, and its prior answers "no". "Does this printed description
    // describe your task" is a yes/no about text on the screen, with both
    // answers named — ask, or say nothing and solve the task — and it is the
    // only check that catches the failure BM25 guarantees: a rare word ranks
    // its WRONG sense highest, so `insomnia help` surfaces a REST client and
    // `stress management` a load tester, both above real matches. Measured on
    // the 52-query calibration set, 72% of the rows that clear 0.55 do not
    // deserve a question; every one of them is caught here or nowhere.
    //
    // The cue goes on its own line ABOVE the question: a model that reads the
    // relayable sentence first has already acted.
    const askCue = (rel: number): string =>
      `Likely fit (relevance ${rel.toFixed(2)})${skipClause} — read the row's description first: if it fits the ` +
      `task, ask the question below, first, via the tool if you have it; if it is a different thing with the same ` +
      `word, say nothing and solve the task; if the description is blank or a bare mark (\`>\`, \`|\`), you cannot ` +
      `confirm the fit — say nothing and solve the task.\n`;
    // Above the line with nothing readable anywhere on it. The cue says why
    // no question is printed, because the protocol promises one up here and a
    // model that expects a question and finds none composes its own — and it
    // prints NO question and no install command, which is the same shape
    // ruling 44 removed from the weak band: a stop instruction one line above
    // the only actionable command on screen is decoration, because the
    // actionable line wins at reading speed.
    const unreadableCue = (rel: number, pkg: string): string =>
      `Likely fit (relevance ${rel.toFixed(2)}) — but ${pkg}'s description is blank or a bare mark (\`>\`, \`|\`): ` +
      `nothing here can confirm the fit, so no question is printed. Say nothing and solve the task.\n`;
    // Policy already cleared this row — the user set `trust.auto_install`, so
    // the question it would have been asked has a standing answer, and what
    // the model needs is the command. This case used to print NOTHING: the
    // header promised a line under the rows, the rows ended, and the next
    // thing on screen was the prompt. What was removed here was a command
    // naming a literal `<pkg>` (Rule 1, "run it as printed", cannot be obeyed
    // with a placeholder) — and silence is that defect one step further on,
    // because a model told the line decides and shown no line decides for
    // itself. So: one line, the concrete package, no `<pkg>`.
    //
    // No `--force`. That flag stands in for the user's yes, and `decide()`
    // returned `auto` precisely because the knob makes that yes standing;
    // `install` accepts the bare command in that state (see install.ts).
    // The threshold and the description check still apply above — an `auto`
    // row below the line, or one nobody can describe, is a junk match policy
    // happens to trust, and "install it unattended" is the one sentence this
    // command exists not to print.
    //
    // And a cue above it, in the shape the asking zone uses: the check on its
    // own line, the actionable sentence under it. A readable description is
    // only half of that check. `decide()` reads a publisher, an install count
    // and a scan verdict, and not one of them can see that `insomnia` is a
    // REST client — so the knob, which is a standing yes to the QUESTION
    // ("install from this publisher without asking me each time"), was
    // handing the model a command to run unattended for exactly the 72% of
    // above-threshold rows that deserve no question at all. The ask zone's
    // junk-install path, minus the user. The cue is the same sentence, ending
    // in the same silence, with "run nothing" in place of "ask".
    //
    // The header's one-clause gloss of this label is deliberately unchanged:
    // it says what the label means, six lines up, while the thing that has to
    // be read before the command runs sits directly above the command — where
    // the reader already is when it acts.
    const autoCue = (rel: number): string =>
      `Likely fit (relevance ${rel.toFixed(2)})${skipClauseAuto} — read the row's description first: if it fits ` +
      `the task, run the command below; if it is a different thing with the same word, run nothing, say nothing ` +
      `and solve the task.\n`;
    const autoLine = (x: (typeof askable)[number]): string =>
      // `--matched "<q>"` carries the phrase that found the row into the lock,
      // exactly as the question's command does. Without it an auto install
      // records no phrase, `metaskill list` shows an empty MATCHED column for
      // it, and alreadyPresent's lock short-circuit never fires for the very
      // installs that happen with nobody watching.
      `Policy allows this without asking — run: ${metaskillCmd()} install ${x.r.pkg} --matched "${q}"\n`;
    const verdictLine = !atT.length
      ? `Weak matches only (top relevance ${top.rel.toFixed(2)}) — solve the task yourself, silently.\n`
      : !chosen
        ? unreadableCue(top.rel, top.r.pkg)
        : asked
          ? askCue(asked.rel) +
            `${questionLine(asked.r.pkg, installsLabel(asked.r), publisherOf(asked.r.pkg), asked.r.scan)}\n`
          : autoCue(chosen.rel) + autoLine(chosen);
    // Below the line there is nothing to install, so no install command is
    // printed. Left in place it was the only actionable line on screen, one
    // line under "solve the task yourself" and with exactly one askable
    // package named above it — the contradiction the zones exist to remove,
    // reproduced inside the zone. The no-readable-row case is the same shape
    // and drops it for the same reason: the cue ends in "say nothing and
    // solve the task", and an install command under that sentence is an
    // invitation to ignore it.
    //
    // The package is the concrete one the question names — the fallback row
    // when the fallback fired, never the unreadable row above it, and never
    // `<pkg>`. Rule 1 of SKILL.md is "run the command as printed", and a
    // placeholder is a command the model has to edit before running, which is
    // how a wrong package (or a refusal to run it at all) gets in.
    //
    // It follows a QUESTION, so it prints only when one does: the `auto` line
    // carries its own command (there is no yes to wait for), and this
    // sentence under it would be a second, contradictory one.
    const installLine = !asked
      ? ""
      : `Install only on the user's explicit yes: ${metaskillCmd()} install ${asked.r.pkg} --force --matched "${q}"\n`;
    process.stdout.write(
      // No adjudication in the header. It used to open by asking the model to
      // rule on whether any row fitted, and to fall back on itself if none
      // did — the same escape hatch the protocol dropped, in the strongest
      // position it ever held: first sentence of the tool result, read in the
      // decision turn, six lines above the question. The header now states
      // the rule and points at the line that has already applied it, so there
      // is nothing here to weigh. test/protocol.test.ts fails if either
      // wording comes back, in code or in a comment — and fails too if the
      // number here drifts from MIN_ASK_RELEVANCE, which is why it is
      // interpolated rather than typed.
      `[metaskill] Top matches for "${q}" — find does not install. The line under the rows has applied these rules to ` +
        `the top row you could install: \`Ask the user:\` (relevance >= ${MIN_ASK_RELEVANCE.toFixed(2)}) — read ` +
        `that row's description; if it is a different thing with the same word, or has no description, say nothing and ` +
        `solve the task; otherwise ask that question FIRST, before any work; \`Weak matches only\` (under ` +
        `${MIN_ASK_RELEVANCE.toFixed(2)}) — solve the task yourself, silently; \`Policy allows this without asking\` ` +
        `(you set \`trust.auto_install\`) — no question to put: run the command that line names.\n` +
        askable.map((x) => line(x.r, x.rel, x.v.decision, x.v.reason)).join("\n") +
        // The question first, then the command that is only valid once it has
        // been answered. --matched carries this exact (already-normalised)
        // query into the lock on a confirmed install, so a repeat of it
        // short-circuits here next time via alreadyPresent's lock check above
        // — see install.ts.
        `\n${verdictLine}${installLine}${deniedBlock}${pluginLine}`,
    );
    logFind([], [...askable, ...denied].map(toDiscovered));
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] find error: ${(err as Error).message}\n`);
    return 0;
  }
}
