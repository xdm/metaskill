import { loadIndex, normaliseQuery, RELEVANCE_BANDS, scanResultFromIndex, search } from "../index/read.js";
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
// BOTH the >= 1.0 cue's wording and the gate that suppresses the question
// under it — one function, so the sentence on screen and the lines printed
// beneath it can never disagree about the same row.
//
// 900 of the shipped snapshot's 4,831 records land here (18.6%): the registry
// carries YAML block-scalar markers where a description should be, so the
// index stores `>`, `|`, `>-` or an empty string. Those rows still rank —
// on the skill NAME alone, which is exactly how a name-shaped match reaches a
// high relevance with nothing behind it. The indexer-side defect is deferred;
// this is the runtime refusing to act on data it cannot read.
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
// (if any) answers the task. BM25 cannot judge whether "say hello" is really
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
// nothing ready to say, so the cheapest reading of the rows ("judge whether
// one fits") won. Handing over the finished sentence is the same move that
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
// record — only a Candidate — and the protocol now promises the model a
// printed question on BOTH branches. One function, one sentence shape.
//
// Split in two so the borderline band can hand over the SAME sentence without
// the `Ask the user:` label. The label is bound to `relevance` >= 1.0 in all
// three documents and cross-checked by test/protocol.test.ts; printing it at
// 0.85 would tell the model "relay this" exactly where the rule says "judge
// first", which is the pre-band pathology in miniature. What the borderline
// band was missing is not the label, it is the sentence: at 0.85 on the
// second real v2 use the model judged correctly and then had to compose the
// question itself, and what it composed arrived as the last line of an answer
// it had already begun.
function questionSentence(pkg: string, installs: string, publisher: string, scan: string): string {
  return `Install ${pkg} (${installs} installs, publisher ${publisher}, scan ${scan}) for this task? yes/no`;
}

function questionLine(pkg: string, installs: string, publisher: string, scan: string): string {
  return `Ask the user: ${questionSentence(pkg, installs, publisher, scan)}`;
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
    // report how much of a query a row matched, it cannot judge whether the
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
    // The first row whose decision is `ask` — not simply `rows[0]`. A denied
    // row can outrank every askable one, and suppressing the question on that
    // account would refuse to ask about a package policy is willing to
    // install because a different package is not. An `auto` row above it (the
    // knob is on) needs no question by definition, so it does not get one.
    const topAsk = askable.find((x) => x.v.decision === "ask");
    // The >= 1.0 band with nothing to read on the row it would ask about.
    // Computed once, here, because it decides BOTH what the cue says and
    // whether a question and an install command print under it — the same
    // shape ruling 44 removed from the weak band, where "solve the task
    // yourself" sat one line above the only actionable command on screen. A
    // cue ending "you cannot confirm the fit — say nothing" with a
    // free-standing `Ask the user: Install X?` under it is that contradiction
    // again, and the actionable line wins at reading speed every time.
    const askBandUnreadable =
      !!topAsk && topAsk.rel >= RELEVANCE_BANDS.ask && descriptionUnreadable(topAsk.r.description);
    // The bands, applied here rather than described in prose somewhere else.
    // The question used to print at every relevance — a 0.08 top row got the
    // same ready-to-relay sentence as a 1.58 one — so the cheapest action was
    // "ask" exactly where the rule says be silent, and the line carried no
    // number for the model to catch itself on. Now the row's own relevance
    // picks which band's verdict is printed, and every one of them names the
    // number it was decided on. `find` still installs nothing on any band.
    const verdictLine = !topAsk
      ? "" // every askable row is `auto` (the knob is on): no question to ask
      : topAsk.rel >= RELEVANCE_BANDS.ask
        ? // The question is unchanged and still printed: it is the relay when
          // the answer is yes, and composing it was the step the model
          // skipped on the first real v2 lookup. Above it now sits the one
          // check the score cannot make. A 47-query probe of everyday life
          // and work phrases put 26 of them in this band, and most of those
          // top rows are homonyms: "insomnia help" -> insomnia-collection-
          // generator (a REST client, relevance 1.28), "stress management" ->
          // stress-test (load testing, 1.20), "time management" ->
          // itinerary-optimizer, "language learning" -> vision-sft. A rare
          // query word carries high idf, so the wrong sense of it scores
          // HIGH — which is exactly where the old rule said "put that
          // question to the user before anything else", i.e. ask "Install
          // insomnia-collection-generator?" on a sleep question.
          //
          // The check is ONE question with both answers named — does the
          // printed description fit the task: ask, or say nothing and solve
          // it — not "decide whether to bother", which is the free judgement
          // the bands exist to remove and which the first incident answered
          // "no". It goes on its own line ABOVE the question, because a model
          // that reads the relayable sentence first has already acted.
          //
          // The rows with nothing to read get a different line and NO
          // question: 900 of the snapshot's 4,831 records carry a blank or
          // bare-block-mark description (18.6%), and 7 of the 44 answerable
          // fixture queries hit one as their TOP row (`insomnia help`, `home
          // workout`, `goal setting`, `public speaking`, `investing basics`,
          // `tax filing personal`, `home organization`). "Fits the task" and
          // "a different thing with the same word" both assume text, so the
          // check cannot be made at all — and a check that cannot be made
          // must not be followed by the sentence it was supposed to gate.
          // The line says why nothing is printed, because the protocol
          // promises a question in this band and a model that expects one and
          // finds none will compose its own. (The indexer-side defect —
          // descriptions lost to YAML block scalars — is deferred; this is
          // the runtime refusing to act on data it cannot read.)
          askBandUnreadable
          ? `Likely fit (relevance ${topAsk.rel.toFixed(2)}) — but ${topAsk.r.pkg}'s description is blank or a bare ` +
            `mark (\`>\`, \`|\`): nothing here can confirm the fit, so no question is printed. Say nothing and ` +
            `solve the task.\n`
          : `Likely fit (relevance ${topAsk.rel.toFixed(2)}) — read the row's description first: if it fits the task, ` +
            `ask the question below, first, via the tool if you have it; if it is a different thing with the same word, ` +
            `say nothing and solve the task; if the description is blank or a bare mark (\`>\`, \`|\`), you cannot ` +
            `confirm the fit — say nothing and solve the task.\n` +
            `${questionLine(topAsk.r.pkg, installsLabel(topAsk.r), publisherOf(topAsk.r.pkg), topAsk.r.scan)}\n`
        : topAsk.rel >= RELEVANCE_BANDS.judge
          ? `Borderline match (relevance ${topAsk.rel.toFixed(2)}) — judge whether ${topAsk.r.pkg} fits. ` +
            `If it does, ask exactly this, first — via the tool if you have it, else as one line and nothing else: ` +
            `${questionSentence(topAsk.r.pkg, installsLabel(topAsk.r), publisherOf(topAsk.r.pkg), topAsk.r.scan)}\n`
          : `Weak matches only (top relevance ${topAsk.rel.toFixed(2)}) — solve the task yourself.\n`;
    // Below the judge band there is nothing to install, so no install command
    // is printed. Left in place it was the only actionable line on screen,
    // one line under "solve the task yourself" and with exactly one askable
    // package named above it — the contradiction the bands exist to remove,
    // reproduced inside the band. The unreadable-description case at >= 1.0
    // is the same shape and drops it for the same reason: the cue there ends
    // in "say nothing and solve the task", and an install command under that
    // sentence is an invitation to ignore it. Every other case keeps the line: the
    // borderline cue now ends in a question to ask, the ask band has its
    // own, and with no row named (all askable rows `auto`, the knob on) the
    // template is all there is to print.
    //
    // The borderline cue says WHEN as well as whether: "judge whether X
    // fits. If it does, ask exactly this, first — via the tool if you have
    // it, else as one line and nothing else: …". It ended "and nothing else"
    // full stop, which is true of the text fallback and false of the
    // AskUserQuestion path the protocol tells the model to prefer: that tool
    // necessarily splits the sentence into an option label and a description,
    // so the cue forbade the better way of asking. It now names both, in the
    // protocol's own order. It used to read "judge whether X fits before
    // asking", an ordering a model satisfies by asking at the end of an
    // answer it has already given —
    // which is what happened at 0.85 on the second real v2 use. Judgement
    // stays in front of the sentence, so the band still costs a decision;
    // what it no longer costs is composing the question after making it.
    // The three documents that carry this rule — this line, the header
    // above, and the protocol block — say "first" in the same words, and
    // test/protocol.test.ts fails if the header and the block drift apart.
    //
    // The package is the concrete one the line above names, not `<pkg>`.
    // Rule 1 of SKILL.md is "run the command as printed", and a placeholder
    // is a command the model has to edit before running — which is how a
    // wrong package, or a refusal to run it at all, gets in. The live branch
    // has always printed the real package; these two branches now agree.
    const installLine =
      topAsk && (topAsk.rel < RELEVANCE_BANDS.judge || askBandUnreadable)
        ? ""
        : `Install only on the user's explicit yes: ${metaskillCmd()} install ${topAsk?.r.pkg ?? "<pkg>"} --force --matched "${q}"\n`;
    process.stdout.write(
      // No judgement in the header. It used to open by asking the model to
      // rule on whether any row fitted, and to fall back on itself if none
      // did — the same escape hatch the protocol dropped, in the strongest
      // position it ever held: first sentence of the tool result, read in
      // the decision turn, six lines above the question. The header now
      // states the rule and points at the line that has already applied it,
      // so there is nothing here to adjudicate. test/protocol.test.ts fails
      // if either wording comes back, in code or in a comment.
      //
      // The description check the >= 1.0 band now carries is not that
      // judgement returning. "Judge which row, if any, fits" asks the model
      // whether to engage at all, and its prior answers "no"; "does this
      // description describe your task" is a single yes/no about text
      // printed on the row itself, with both answers spelled out — ask, or say
      // nothing and solve the task. It is also the only check that can catch
      // the failure BM25 guarantees: a homonym whose shared word is rare
      // scores higher than the real match, not lower (see the verdict line).
      `[metaskill] Top matches for "${q}" — find does not install. The line under the rows has applied the relevance ` +
        `rule to the top row you could install: \`Ask the user:\` (relevance >= ${RELEVANCE_BANDS.ask.toFixed(1)}) — likely ` +
        `fit: read the row's description; if it fits the task, ask that question first; if it is a different thing with ` +
        `the same word, say nothing and solve the task; \`Borderline match\` — judge whether it fits, then ask first; ` +
        `\`Weak matches only\` (under ${RELEVANCE_BANDS.judge.toFixed(1)}) — solve the task yourself.\n` +
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
