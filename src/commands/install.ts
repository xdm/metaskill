import { publisherOf } from "../discover.js";
import { findByPkg, loadIndex, scanResultFromIndex } from "../index/read.js";
import { installSkill } from "../install.js";
import { decide, loadPolicy } from "../policy.js";
import { scanCandidate } from "../scan.js";
import type { Candidate, ScanResult } from "../types.js";

export interface InstallFlags {
  force?: boolean;
}

// Manual `metaskill install <pkg>`: same policy and scan as the automatic
// path. --force bypasses `ask` but never `deny` — deny cannot be bypassed by
// any flag, on this path or the automatic one.
export async function installCommand(pkg: string | undefined, flags: InstallFlags): Promise<number> {
  if (!pkg) {
    process.stderr.write("usage: metaskill install <owner/repo@skill> [--force]\n");
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
      `Needs confirmation (${verdict.reason}). Re-run with --force after the user has approved it.\n`,
    );
    return 1;
  }

  const res = await installSkill(pkg, undefined, { timeoutMs: 120_000 });
  if (!res.ok) {
    process.stderr.write(`install failed: ${res.error ?? "unknown error"}\n`);
    return 1;
  }
  process.stdout.write(
    `Installed ${pkg}${res.version ? ` (v${res.version})` : ""}${res.skillMdPath ? ` -> ${res.skillMdPath}` : ""}\n`,
  );
  return 0;
}
