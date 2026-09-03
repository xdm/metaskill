import { publisherOf } from "../discover.js";
import { findByPkg, loadIndex, normaliseQuery, scanResultFromIndex } from "../index/read.js";
import { installSkill } from "../install.js";
import { appendLog, hashPrompt } from "../log.js";
import { decide, loadPolicy } from "../policy.js";
import { scanCandidate } from "../scan.js";
import type { Candidate, ScanResult } from "../types.js";

export interface InstallFlags {
  force?: boolean;
  // The phrase that found this package — normally copied verbatim from the
  // `--matched "<q>"` flag on the command `find` itself printed, already
  // normalised there. Normalised again here through the SAME function (never
  // a second copy — see index/read.ts), so a hand-typed or edited value lands
  // in the lock exactly as `find`'s reinstall check needs it to short-circuit
  // a repeat of the phrase that found this skill.
  matched?: string;
}

// Manual `metaskill install <pkg>`: same policy and scan as the automatic
// path. --force bypasses `ask` but never `deny` — deny cannot be bypassed by
// any flag, on this path or the automatic one.
export async function installCommand(pkg: string | undefined, flags: InstallFlags): Promise<number> {
  const t0 = Date.now();
  if (!pkg) {
    process.stderr.write('usage: metaskill install <owner/repo@skill> [--force] [--matched "<phrase>"]\n');
    return 2;
  }
  const policy = loadPolicy();
  const candidate: Candidate = {
    pkg,
    publisher: publisherOf(pkg),
    skillName: pkg.slice(pkg.lastIndexOf("@") + 1),
    installs: 0, // unknown for a manually named package
    url: "",
  };

  // The local index already carries a scan verdict for every package it knows
  // (spec 7 Defect 2: the runtime reads a field, it does not re-download a
  // tarball), so it is consulted FIRST — for every publisher, allowlisted or
  // not. This path used to run no scan at all for an allowlisted publisher
  // and hand decide() a bare "skipped", which is how
  // `install anthropics/skills@xlsx` installed, silently, a package the very
  // index shipped in this package marks dirty. Only a package the index has
  // never heard of falls back to the live tarball scan.
  let scan: ScanResult = { status: "skipped", findings: [], advisories: [] };
  const index = loadIndex();
  const indexed = index ? findByPkg(index, pkg) : null;
  if (indexed) {
    scan = scanResultFromIndex(indexed);
  } else if (!policy.trust.denyPublishers.includes(candidate.publisher)) {
    // A denied publisher is refused below whatever the scan says; downloading
    // its tarball first would be work with no decision riding on it.
    process.stdout.write(`Scanning ${pkg} ...\n`);
    scan = await scanCandidate(candidate, policy);
  }

  const verdict = decide(candidate, scan, policy);
  if (verdict.decision === "deny") {
    process.stderr.write(`DENIED: ${verdict.reason}\n`);
    if (scan.findings.length) process.stderr.write(scan.findings.map((f) => `  - ${f}`).join("\n") + "\n");
    process.stderr.write("`deny` cannot be bypassed by any flag.\n");
    return 1;
  }
  if (verdict.decision === "ask" && !flags.force) {
    process.stderr.write(
      // `Needs confirmation` already names the action, so the reason's own
      // `needs your yes — ` opener (policy.ts) would say it twice here. It is
      // stripped at this one wrap site only; everywhere the reason stands on
      // its own — every row `find` prints — it keeps the prefix.
      `Needs confirmation (${verdict.reason.replace(/^needs your yes — /, "")}). Re-run with --force after the user has approved it.\n`,
    );
    return 1;
  }

  // Empty, not merely undefined, collapses to "no phrase": a `--matched`
  // that normalises away to nothing (e.g. all punctuation) must not record an
  // empty-string domain, which `list` would render as a blank cell rather
  // than "-".
  const matched = normaliseQuery(flags.matched ?? "");
  const domain = matched.length ? matched : undefined;

  const res = await installSkill(pkg, domain, { timeoutMs: 120_000 });
  if (!res.ok) {
    process.stderr.write(`install failed: ${res.error ?? "unknown error"}\n`);
    return 1;
  }

  // One row per successful install, logged here rather than inside
  // installSkill: this is the only caller a human (via --force) or the
  // model's confirmed "yes" actually drives, so it is the only one that
  // should count. A refused install (deny, or ask without --force) returns
  // above and never reaches this line — nothing is logged for it.
  // followThrough (log.ts) excludes session "install" from both its prompt
  // and find counts: this row is bookkeeping, not a lookup or a routed
  // prompt.
  appendLog(
    {
      ts: new Date().toISOString(),
      session: "install",
      prompt_hash: hashPrompt(`install:${pkg}`),
      domains: [`install:${pkg}`],
      covered: [],
      discovered: [],
      installed: [pkg],
      latency_ms: Date.now() - t0,
    },
    policy,
  );

  process.stdout.write(
    `Installed ${pkg}${res.version ? ` (v${res.version})` : ""}${res.skillMdPath ? ` -> ${res.skillMdPath}` : ""}\n`,
  );
  return 0;
}
