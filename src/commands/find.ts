import { MIN_RELEVANCE, loadIndex, scanResultFromIndex, search } from "../index/read.js";
import { metaskillCmd } from "../paths.js";
import type { IndexRecord } from "../index/types.js";
import { discoverByQuery, publisherOf } from "../discover.js";
import { installSkill } from "../install.js";
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
//        (LockEntry.domain, which findCommand writes on every auto-install).
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

function line(r: IndexRecord, decision: string, reason: string): string {
  const installs = r.installs === null ? `~${r.installsPrior ?? 0} est` : String(r.installs);
  const desc = (r.description ?? "").replace(/\s+/g, " ").slice(0, 140);
  return `  ${r.pkg} (${installs} installs, scan=${r.scan}) [${decision}: ${reason}]\n    ${desc}`;
}

// find is invoked directly by the in-session model via Bash, with no human
// watching and no hook-safe-exit entry in cli.ts's uncaught handler — so
// unlike a thrown error surfacing as `metaskill: <stack>` and exit 1, every
// path through here must degrade to a single printed line and exit 0.
export async function findCommand(query: string, opts: { index?: string } = {}): Promise<number> {
  const t0 = Date.now();
  try {
    const policy = loadPolicy();
    const q = query.toLowerCase().replace(/[^a-z0-9 -]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (q.length < 3) {
      process.stderr.write('usage: metaskill find "<capability words>"\n');
      return 2;
    }

    const logFind = (installed: string[], covered: string[]) =>
      appendLog(
        {
          ts: new Date().toISOString(),
          session: "find",
          prompt_hash: hashPrompt(`find:${q}`),
          domains: [`find:${q}`],
          covered,
          discovered: [],
          installed,
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
      logFind([], [present.name]);
      return 0;
    }

    const index = loadIndex(opts.index);
    let hits = index ? search(index, q, 5) : [];

    // Long tail: the index is a snapshot, so fall back to one live search.
    if (!hits.length) {
      // 3s, not discoverRaw's 10s default. The protocol now tells the model to
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
      process.stdout.write(
        `[metaskill] Not in the local index; live search found ${top.pkg} (${top.installs} installs).\n` +
          `Ask the user one question before installing; on an explicit yes run: ${metaskillCmd()} install ${top.pkg} --force\n${pluginLine}`,
      );
      logFind([], []);
      return 0;
    }

    // Relevance floor. BM25 ranks whatever it is given: before this, EVERY
    // query got a top hit, so "say hello" auto-installed a third-party skill
    // (29 of 30 measured junk phrases did). A top hit this weak is not a
    // worse match, it is not a match — so it is not offered for confirmation
    // either, and no live search is run on its behalf. See MIN_RELEVANCE.
    if (hits[0]!.relevance < MIN_RELEVANCE) {
      process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${pluginLine}`);
      logFind([], []);
      return 0;
    }

    const rows = hits.map((h) => {
      const v = decide(recordToCandidate(h.record), scanResultFromIndex(h.record), policy);
      return { r: h.record, v };
    });

    // ONLY the top-ranked hit may install unattended. Taking the first `auto`
    // ROW instead meant a rank-5 hit installed itself whenever ranks 1-4 were
    // `ask` — measured on 25 real capability phrases, 11 installed something
    // that was not the top match. Lower-ranked rows still appear below, where
    // a human decides.
    const auto = rows[0]!.v.decision === "auto" ? rows[0]! : undefined;
    if (auto) {
      // The same 120s the manual `install` path uses. The 20s default was
      // measured timing out at 20.17s on exactly this path — and this is the
      // one nobody is watching.
      const res = await installSkill(auto.r.pkg, q, { timeoutMs: 120_000 });
      if (res.ok) {
        process.stdout.write(
          `[metaskill] Installed now: ${auto.r.pkg}${res.version ? ` (v${res.version})` : ""}${res.skillMdPath ? ` -> ${res.skillMdPath}` : ""}\n` +
            `Read that SKILL.md and follow it.\n${pluginLine}`,
        );
        logFind([auto.r.pkg], []);
        return 0;
      }
      process.stdout.write(
        `[metaskill] Install ${res.timedOut ? "timed out" : "failed"} — ask the user, then run: ${metaskillCmd()} install ${auto.r.pkg} --force\n${pluginLine}`,
      );
      logFind([], []);
      return 0;
    }

    // Denied rows never appear under the ask header. Listed there, above a
    // line reading `install <pkg> --force`, they read as an invitation to go
    // get approval for a package policy has already refused — and no flag
    // installs them, so the only possible outcome was a wasted question and a
    // failed command. They keep their own block, with no command under it.
    const askable = rows.filter((x) => x.v.decision !== "deny");
    const denied = rows.filter((x) => x.v.decision === "deny");
    const deniedBlock = denied.length
      ? `Refused by policy — no flag installs these, do not offer them:\n` +
        denied.map((x) => line(x.r, x.v.decision, x.v.reason)).join("\n") +
        "\n"
      : "";
    if (!askable.length) {
      // Every match refused. `No skills found` is the branch the protocol and
      // SKILL.md already tell the model how to act on (solve it yourself);
      // inventing a label for this case would leave it improvising.
      process.stdout.write(
        `[metaskill] No skills found for "${q}". Solve the task without one.\n${deniedBlock}${pluginLine}`,
      );
      logFind([], []);
      return 0;
    }
    process.stdout.write(
      `[metaskill] Top matches for "${q}" — none auto-installable, ask the user ONE question before installing any:\n` +
        askable.map((x) => line(x.r, x.v.decision, x.v.reason)).join("\n") +
        `\nOn an explicit yes run: ${metaskillCmd()} install <pkg> --force\n${deniedBlock}${pluginLine}`,
    );
    logFind([], []);
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] find error: ${(err as Error).message}\n`);
    return 0;
  }
}
