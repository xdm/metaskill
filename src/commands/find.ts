import { loadIndex, normaliseQuery, scanResultFromIndex, search } from "../index/read.js";
import { metaskillCmd } from "../paths.js";
import type { IndexRecord } from "../index/types.js";
import { discoverByQuery, publisherOf } from "../discover.js";
import { listInstalledSkills } from "../inventory.js";
import { readLock } from "../lock.js";
import { findPlugins, formatPluginLine } from "../plugins.js";
import { decide, loadPolicy } from "../policy.js";
import { appendLog, hashPrompt } from "../log.js";
import type { Candidate, InstalledSkill } from "../types.js";

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

// `relevance` is printed because the model, not the code, now picks which row
// (if any) answers the task. BM25 cannot judge whether "say hello" is really
// about a greeting skill; it only reports how much of the query the row
// matched, and 0.00-1.x is the one number that says so comparably across
// index sizes. A reader who sees every row at 0.4 has been told what a
// hard-coded floor used to decide for them, and can still see the rows.
function line(r: IndexRecord, relevance: number, decision: string, reason: string): string {
  const installs = r.installs === null ? `~${r.installsPrior ?? 0} est` : String(r.installs);
  const desc = (r.description ?? "").replace(/\s+/g, " ").slice(0, 140);
  return `  ${r.pkg} (${installs} installs, scan=${r.scan}, relevance=${relevance.toFixed(2)}) [${decision}: ${reason}]\n    ${desc}`;
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
    const logFind = (covered: string[]) =>
      appendLog(
        {
          ts: new Date().toISOString(),
          session: "find",
          prompt_hash: hashPrompt(`find:${q}`),
          domains: [`find:${q}`],
          covered,
          discovered: [],
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
      logFind([present.name]);
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
          logFind([]);
          return 0;
        }
        process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${pluginLine}`);
        logFind([]);
        return 0;
      }
      const top = [...cands].sort((a, b) => b.installs - a.installs)[0]!;
      process.stdout.write(
        `[metaskill] Not in the local index; live search found ${top.pkg} (${top.installs} installs).\n` +
          // Same --matched carry as the local-index branch below: whichever
          // path led to this confirmed install, the lock should end up with
          // the phrase that found it, or alreadyPresent's short-circuit only
          // works for half of `find`'s outcomes.
          `Ask the user one question before installing; on an explicit yes run: ${metaskillCmd()} install ${top.pkg} --force --matched "${q}"\n${pluginLine}`,
      );
      logFind([]);
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
      const v = decide(recordToCandidate(h.record), scanResultFromIndex(h.record), policy);
      return { r: h.record, rel: h.relevance, v };
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
      logFind([]);
      return 0;
    }
    process.stdout.write(
      `[metaskill] Top matches for "${q}" — find does not install. Judge whether one of these actually fits the task; ` +
        `if none does, solve it yourself. Before installing any, ask the user ONE question:\n` +
        askable.map((x) => line(x.r, x.rel, x.v.decision, x.v.reason)).join("\n") +
        // --matched carries this exact (already-normalised) query into the
        // lock on a confirmed install, so a repeat of it short-circuits here
        // next time via alreadyPresent's lock check above — see install.ts.
        `\nInstall only on the user's explicit yes: ${metaskillCmd()} install <pkg> --force --matched "${q}"\n${deniedBlock}${pluginLine}`,
    );
    logFind([]);
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] find error: ${(err as Error).message}\n`);
    return 0;
  }
}
