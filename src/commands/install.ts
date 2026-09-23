import { removeDecline } from "../declines.js";
import { publisherOf } from "../discover.js";
import { findByPkg, loadIndex, normaliseQuery, scanResultFromIndex } from "../index/read.js";
import { installSkill } from "../install.js";
import { appendLog, hashPrompt } from "../log.js";
import { decide, loadPolicy } from "../policy.js";
import { scanCandidate } from "../scan.js";
import type { Candidate, ScanResult } from "../types.js";

export interface InstallFlags {
  force?: boolean;
  // The phrase that found this package, from the `--matched "<q>"` flag on
  // the command `find` printed. Normalised through the same function as
  // `find`'s query, so the lock holds exactly what a later `find` compares.
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

  // The local index carries a scan verdict for every package it knows, so it
  // is consulted first for every publisher, allowlisted or not; only a
  // package the index has never heard of gets the live tarball scan.
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
      // `Needs confirmation` already names the action the reason opens with.
      `Needs confirmation (${verdict.reason.replace(/^needs your yes — /, "")}). Re-run with --force after the user has approved it.\n`,
    );
    return 1;
  }

  // A `--matched` that normalises to nothing records no phrase, not "".
  const matched = normaliseQuery(flags.matched ?? "");
  const domain = matched.length ? matched : undefined;

  const res = await installSkill(pkg, domain, { timeoutMs: 120_000 });
  if (!res.ok) {
    process.stderr.write(`install failed: ${res.error ?? "unknown error"}\n`);
    return 1;
  }
  // Installing a package the user once said no to is the undo of that no —
  // there is no other one, by design (declines.ts).
  removeDecline(pkg);

  // One log row per confirmed install; a refused one returned above.
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
