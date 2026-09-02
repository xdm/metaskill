import { loadIndex, search } from "../index/read.js";
import type { IndexRecord } from "../index/types.js";
import { discoverByQuery, publisherOf } from "../discover.js";
import { installSkill } from "../install.js";
import { listInstalledSkills } from "../inventory.js";
import { findPlugins, formatPluginLine } from "../plugins.js";
import { decide, loadPolicy } from "../policy.js";
import { appendLog, hashPrompt } from "../log.js";
import type { Candidate, ScanResult } from "../types.js";

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

// The index already carries a scan verdict per skill, so the runtime never
// downloads a tarball on this path (spec §7 Defect 2).
// loadIndex/readOne only validates that `skills` is an array, never the shape
// of each record, so a hand-edited or corrupted index.json can omit these
// arrays entirely (or carry an explicit `null`) — default them, or a dirty
// scan (policy.ts's `scan.findings.slice`) or an advisory check
// (`scan.advisories.length`) throws before find ever gets to print anything.
function scanFromIndex(r: IndexRecord): ScanResult {
  return {
    status: r.scan === "unknown" ? "unavailable" : r.scan,
    findings: r.scanFindings ?? [],
    advisories: r.scanAdvisories ?? [],
  };
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

    // Reinstall protection: an installed skill whose name matches the query
    // answers it without touching the index or the network.
    const installed = listInstalledSkills(process.cwd());
    const words = q.split(" ").filter((w) => w.length >= 3);
    const present = installed.find((s) => words.some((w) => s.name.toLowerCase().includes(w)));
    if (present) {
      process.stdout.write(`[metaskill] Already present: ${present.name} — use ${present.dir}/SKILL.md\n${pluginLine}`);
      logFind([], [present.name]);
      return 0;
    }

    const index = loadIndex(opts.index);
    let hits = index ? search(index, q, 5) : [];

    // Long tail: the index is a snapshot, so fall back to one live search.
    if (!hits.length) {
      const cands = await discoverByQuery(q);
      if (!cands.length) {
        process.stdout.write(`[metaskill] No skills found for "${q}". Solve the task without one.\n${pluginLine}`);
        logFind([], []);
        return 0;
      }
      const top = [...cands].sort((a, b) => b.installs - a.installs)[0]!;
      process.stdout.write(
        `[metaskill] Not in the local index; live search found ${top.pkg} (${top.installs} installs).\n` +
          `Ask the user one question before installing; on an explicit yes run: metaskill install ${top.pkg} --force\n${pluginLine}`,
      );
      logFind([], []);
      return 0;
    }

    const rows = hits.map((h) => {
      const v = decide(recordToCandidate(h.record), scanFromIndex(h.record), policy);
      return { r: h.record, v };
    });

    const auto = rows.find((x) => x.v.decision === "auto");
    if (auto) {
      const res = await installSkill(auto.r.pkg, undefined);
      if (res.ok) {
        process.stdout.write(
          `[metaskill] Installed now: ${auto.r.pkg}${res.version ? ` (v${res.version})` : ""}${res.skillMdPath ? ` -> ${res.skillMdPath}` : ""}\n` +
            `Read that SKILL.md and follow it.\n${pluginLine}`,
        );
        logFind([auto.r.pkg], []);
        return 0;
      }
      process.stdout.write(
        `[metaskill] Install ${res.timedOut ? "timed out" : "failed"} — ask the user, then run: metaskill install ${auto.r.pkg} --force\n${pluginLine}`,
      );
      logFind([], []);
      return 0;
    }

    process.stdout.write(
      `[metaskill] Top matches for "${q}" — none auto-installable, ask the user ONE question before installing any:\n` +
        rows.map((x) => line(x.r, x.v.decision, x.v.reason)).join("\n") +
        `\nOn an explicit yes run: metaskill install <pkg> --force\n${pluginLine}`,
    );
    logFind([], []);
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] find error: ${(err as Error).message}\n`);
    return 0;
  }
}
