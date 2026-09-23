import { addDecline, DECLINE_DAYS } from "../declines.js";
import { publisherOf } from "../discover.js";
import { findByPkg, loadIndex, normaliseQuery, scanResultFromIndex } from "../index/read.js";
import { appendLog, hashPrompt } from "../log.js";
import { loadPolicy } from "../policy.js";
import type { DiscoveredLogItem } from "../types.js";

export interface DeclineFlags {
  matched?: string;
}

// `metaskill decline <pkg> --matched "<phrase>"` — the model runs this when
// the user answers the printed question with no. The package is written down
// for DECLINE_DAYS (declines.ts) and one log row records it, in the shape of
// an install row, so `log --stats` can count answered questions. No network,
// no policy decision.
//
// Run from a printed line by a model, so it never ends in a stack trace: one
// stderr line and a non-zero exit. The policy (which names the log file) is
// read before anything is written, so a failed command has recorded nothing.
export function declineCommand(pkg: string | undefined, flags: DeclineFlags): number {
  const t0 = Date.now();
  if (!pkg) {
    process.stderr.write('usage: metaskill decline <owner/repo@skill> [--matched "<phrase>"]\n');
    return 2;
  }
  try {
    const policy = loadPolicy();
    // The same normaliser as install's --matched: whatever phrase found this
    // row lands in the file exactly as `find` would spell it.
    const matched = normaliseQuery(flags.matched ?? "");
    addDecline(pkg, matched.length ? matched : undefined);
    // Install count and scan verdict come from the local index when it has
    // the package, and are left out otherwise rather than logged as 0.
    const index = loadIndex();
    const record = index ? findByPkg(index, pkg) : null;
    const discovered: DiscoveredLogItem[] = record
      ? [
          {
            pkg,
            installs: record.installs ?? record.installsPrior ?? 0,
            publisher: publisherOf(pkg),
            decision: "declined",
            scan: scanResultFromIndex(record).status,
          },
        ]
      : [];
    appendLog(
      {
        ts: new Date().toISOString(),
        session: "decline",
        prompt_hash: hashPrompt(`decline:${pkg}`),
        domains: [`decline:${pkg}`],
        covered: [],
        discovered,
        installed: [],
        latency_ms: Date.now() - t0,
      },
      policy,
    );
    process.stdout.write(`Declined ${pkg} for ${DECLINE_DAYS} days — find will not offer it again until then.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`decline failed: ${(err as Error).message}\n`);
    return 1;
  }
}
