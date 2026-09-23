import { readLogEntries } from "../log.js";
import { loadPolicy } from "../policy.js";
import type { RouteLogEntry } from "../types.js";

// Sessions that are a model-driven lookup rather than a routed prompt.
// "search" and "manual" are the retired v1 handoffs; they count as lookups
// so the follow-through baseline measured on them stays comparable.
const LOOKUP_SESSIONS = new Set(["find", "search", "manual"]);

// A ceiling on how many `discovered` items a single tail row prints, so a
// hand-edited or future-schema log line with an unbounded array cannot
// produce one unreadably long line. `find` never writes more than 5 today
// (search()'s own top-N), so this never trims a real row.
const MAX_DISCOVERED_SHOWN = 5;

// Rows metaskill writes about itself: one per confirmed install and one per
// recorded no. They are neither prompts nor lookups, so they stay out of the
// ratio; together they count the questions that reached a user and were
// answered, which the ratio alone cannot see.
const EXCLUDED_SESSIONS = new Set(["install", "decline"]);

// `pct` is capped at 100: a prompt carrying three tasks legitimately
// produces three finds, and "300%" reads as a broken counter. The raw counts
// are printed beside it.
export function followThrough(entries: RouteLogEntry[]): {
  prompts: number;
  finds: number;
  pct: number;
  installs: number;
  declines: number;
} {
  const counted = entries.filter((e) => !EXCLUDED_SESSIONS.has(e.session));
  const finds = counted.filter((e) => LOOKUP_SESSIONS.has(e.session)).length;
  const prompts = counted.length - finds;
  const installs = entries.filter((e) => e.session === "install").length;
  const declines = entries.filter((e) => e.session === "decline").length;
  return { prompts, finds, pct: prompts ? Math.min(100, Math.round((finds / prompts) * 100)) : 0, installs, declines };
}

// `metaskill log [-n N] [--stats]` — human-readable tail of the JSONL log,
// or (with --stats) the find follow-through measurement against the FULL
// log (not just the last N — `n` is ignored in that branch).
export function logCommand(n: number, opts: { stats?: boolean } = {}): number {
  const policy = loadPolicy();
  if (opts.stats) {
    const { prompts, finds, pct, installs, declines } = followThrough(readLogEntries(policy));
    const answered = `answered questions=${installs + declines}  (installs=${installs} declines=${declines})\n`;
    // With no prompts logged there is no ratio to report. Printing
    // "follow-through=0%" for prompts=0 finds=1 states the opposite of what
    // the log holds — a lookup ran, and nothing it could have followed did.
    if (prompts === 0) {
      process.stdout.write(
        `prompts=0 finds=${finds} — no prompts logged yet, so there is no follow-through ratio.\n${answered}`,
      );
      return 0;
    }
    const note = finds > prompts ? "  (more finds than prompts — a prompt can carry several tasks)" : "";
    process.stdout.write(
      `prompts=${prompts} finds=${finds} follow-through=${pct}%  (baseline before the protocol: 3%)${note}\n${answered}`,
    );
    return 0;
  }
  const entries = readLogEntries(policy, n);
  if (!entries.length) {
    process.stdout.write(`No log entries at ${policy.log.path}.\n`);
    return 0;
  }
  for (const e of entries) {
    const notInstalled = e.discovered.filter((d) => !e.installed.includes(d.pkg));
    // `find` never carries more than 5, so this cap only guards against a
    // hand-edited or future log line.
    const shown = notInstalled.slice(0, MAX_DISCOVERED_SHOWN);
    const overflow = notInstalled.length - shown.length;
    const parts = [
      e.ts,
      `domains=[${e.domains.join(",")}]`,
      e.covered.length ? `covered=[${e.covered.join(",")}]` : null,
      e.installed.length ? `installed=[${e.installed.join(",")}]` : null,
      ...shown.map((d) => `${d.decision}:${d.pkg}(${d.installs},scan=${d.scan})`),
      overflow > 0 ? `+${overflow} more` : null,
      `${e.latency_ms}ms`,
    ].filter(Boolean);
    process.stdout.write(parts.join(" ") + "\n");
  }
  return 0;
}
