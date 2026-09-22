import { addDecline, DECLINE_DAYS } from "../declines.js";
import { publisherOf } from "../discover.js";
import { normaliseQuery } from "../index/read.js";
import { appendLog, hashPrompt } from "../log.js";
import { loadPolicy } from "../policy.js";

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
// answered questions. No network, no policy — a no needs neither.
export function declineCommand(pkg: string | undefined, flags: DeclineFlags): number {
  const t0 = Date.now();
  if (!pkg) {
    process.stderr.write('usage: metaskill decline <owner/repo@skill> [--matched "<phrase>"]\n');
    return 2;
  }
  // The same normaliser as install's --matched: whatever phrase found this
  // row lands in the file exactly as `find` would spell it.
  const matched = normaliseQuery(flags.matched ?? "");
  addDecline(pkg, matched.length ? matched : undefined);
  appendLog(
    {
      ts: new Date().toISOString(),
      session: "decline",
      prompt_hash: hashPrompt(`decline:${pkg}`),
      domains: [`decline:${pkg}`],
      covered: [],
      discovered: [{ pkg, installs: 0, publisher: publisherOf(pkg), decision: "declined", scan: "skipped" }],
      installed: [],
      latency_ms: Date.now() - t0,
    },
    loadPolicy(),
  );
  process.stdout.write(`Declined ${pkg} for ${DECLINE_DAYS} days — find will not offer it again until then.\n`);
  return 0;
}
