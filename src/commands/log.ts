import { readLogEntries } from "../log.js";
import { loadPolicy } from "../policy.js";
import type { RouteLogEntry } from "../types.js";

// Sessions that represent a model-driven lookup rather than a plain routed
// prompt. "find" is the current `metaskill find` handoff; "search" and
// "manual" are the retired v1 handoffs (`route --search`, `route --domains`)
// — they are model-driven lookups too, and they are the 8 rows that produced
// the measured 2026-08-31 baseline (3%). Counting them as prompts instead of
// finds would undercount that baseline and flatter any after-measurement, so
// legacy v1 handoff rows count as lookups here for an apples-to-apples
// before/after.
const LOOKUP_SESSIONS = new Set(["find", "search", "manual"]);

export function followThrough(entries: RouteLogEntry[]): { prompts: number; finds: number; pct: number } {
  const finds = entries.filter((e) => LOOKUP_SESSIONS.has(e.session)).length;
  const prompts = entries.length - finds;
  return { prompts, finds, pct: prompts ? Math.round((finds / prompts) * 100) : 0 };
}

// `metaskill log [-n N] [--stats]` — human-readable tail of the JSONL log,
// or (with --stats) the find follow-through measurement against the FULL
// log (not just the last N — `n` is ignored in that branch).
export function logCommand(n: number, opts: { stats?: boolean } = {}): number {
  const policy = loadPolicy();
  if (opts.stats) {
    const { prompts, finds, pct } = followThrough(readLogEntries(policy));
    process.stdout.write(`prompts=${prompts} finds=${finds} follow-through=${pct}%  (baseline 2026-08-31: 3%)\n`);
    return 0;
  }
  const entries = readLogEntries(policy, n);
  if (!entries.length) {
    process.stdout.write(`No log entries at ${policy.log.path}.\n`);
    return 0;
  }
  for (const e of entries) {
    const parts = [
      e.ts,
      `domains=[${e.domains.join(",")}]`,
      e.covered.length ? `covered=[${e.covered.join(",")}]` : null,
      e.installed.length ? `installed=[${e.installed.join(",")}]` : null,
      ...e.discovered
        .filter((d) => !e.installed.includes(d.pkg))
        .map((d) => `${d.decision}:${d.pkg}(${d.installs},scan=${d.scan})`),
      `${e.latency_ms}ms`,
    ].filter(Boolean);
    process.stdout.write(parts.join(" ") + "\n");
  }
  return 0;
}
