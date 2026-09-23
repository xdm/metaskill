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
// the user answers `Ask the user: Install <pkg> ...?` with no. It is the
// second half of the question `find` prints: the yes has had a command
// (`install --force`) since v2, and the no had nothing, so the log could not
// tell a no from a question never asked, and `find` put the same package
// back on top the next morning. Two things happen here and nothing else: the
// package is written down for DECLINE_DAYS (declines.ts), and one log row
// records it, in the same shape as an install row so `log --stats` can count
// answered questions. No network, no policy decision — a no needs neither.
//
// Like `find`, this is run from a printed line by a model, so it never ends
// in a stack trace: one line on stderr and a non-zero exit is the whole
// failure. The policy (which names the log file) is read BEFORE anything is
// written, so a command that fails has recorded nothing — a no saved by a
// command that reported failure is a no the user cannot see in `log`.
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
    // The log row names the package in `domains` whatever else is known. Its
    // install count and scan verdict come from the local index when it has
    // the package — the numbers `find` printed beside the question — and are
    // left out otherwise, rather than written as 0 and "skipped", which
    // `metaskill log` would print next to real counts as if measured.
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
