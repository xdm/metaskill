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

// A ceiling on how many `discovered` items a single tail row prints, so a
// hand-edited or future-schema log line with an unbounded array cannot
// produce one unreadably long line. `find` never writes more than 5 today
// (search()'s own top-N), so this never trims a real row.
const MAX_DISCOVERED_SHOWN = 5;

// Rows metaskill writes about itself rather than about a prompt or a
// model-driven lookup. "install" is `install`'s own bookkeeping row (spec:
// one per successful install, so `list`/`log` have a record) — it answers no
// task and follows no find, so it belongs in neither `finds` (it would
// inflate follow-through with rows that were never a lookup) nor `prompts`
// (it would deflate the ratio with a prompt that never happened; a confirmed
// install can trail a `route` prompt by an arbitrary number of turns, or run
// from a shell with no prompt behind it at all).
const EXCLUDED_SESSIONS = new Set(["install"]);

// `pct` is capped at 100. finds > prompts is a real, ordinary state — the
// protocol asks for a find per TASK while route logs one row per PROMPT, so a
// single prompt carrying three tasks legitimately produces three finds — and
// "follow-through=300%" reads as a broken counter, not as good news. The
// uncapped truth is still available: prompts and finds are printed raw.
export function followThrough(entries: RouteLogEntry[]): { prompts: number; finds: number; pct: number } {
  const counted = entries.filter((e) => !EXCLUDED_SESSIONS.has(e.session));
  const finds = counted.filter((e) => LOOKUP_SESSIONS.has(e.session)).length;
  const prompts = counted.length - finds;
  return { prompts, finds, pct: prompts ? Math.min(100, Math.round((finds / prompts) * 100)) : 0 };
}

// `metaskill log [-n N] [--stats]` — human-readable tail of the JSONL log,
// or (with --stats) the find follow-through measurement against the FULL
// log (not just the last N — `n` is ignored in that branch).
export function logCommand(n: number, opts: { stats?: boolean } = {}): number {
  const policy = loadPolicy();
  if (opts.stats) {
    const { prompts, finds, pct } = followThrough(readLogEntries(policy));
    // With no prompts logged there is no ratio to report. Printing
    // "follow-through=0%" for prompts=0 finds=1 states the opposite of what
    // the log holds — a lookup ran, and nothing it could have followed did.
    if (prompts === 0) {
      process.stdout.write(
        `prompts=0 finds=${finds} — no prompts logged yet, so there is no follow-through ratio.\n`,
      );
      return 0;
    }
    const note = finds > prompts ? "  (more finds than prompts — a prompt can carry several tasks)" : "";
    process.stdout.write(
      `prompts=${prompts} finds=${finds} follow-through=${pct}%  (baseline 2026-08-31: 3%)${note}\n`,
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
    // `find` never carries more than 5 (search()'s own top-N), so this cap
    // does not shorten a real row today — it is a ceiling against a
    // hand-edited or future log line, not a reduction of what `find` found
    // (task 14: hiding hits here would just reintroduce a milder version of
    // the "found nothing" defect this row exists to fix).
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
