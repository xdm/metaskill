import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import { defaultLogPath, policyPath } from "./paths.js";
import type { Candidate, Policy, PolicyDecision, ScanResult } from "./types.js";

export function defaultPolicy(): Policy {
  return {
    version: 1,
    trust: {
      allowlist: ["anthropics", "vercel-labs"],
      autoThreshold: { minInstalls: 5000, requireCleanScan: true },
      denySkills: [],
      denyPublishers: [],
      autoInstall: false,
    },
    scan: {
      denyIfContains: ["hooks/", ".mcp.json", "curl ", "wget ", "eval(", "process.env", "os.environ"],
      maxArchiveKb: 2048,
    },
    log: { path: defaultLogPath(), retentionDays: 90 },
  };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? os.homedir() + p.slice(1) : p;
}

// Reads ~/.metaskill/metaskill.yaml (snake_case) over built-in defaults. Any
// read/parse failure -> defaults; the hook must never die on a broken config.
export function loadPolicy(): Policy {
  const p = defaultPolicy();
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath(), "utf8");
  } catch {
    return p;
  }
  try {
    const y = (YAML.parse(raw) ?? {}) as Record<string, any>;
    const t = y.trust ?? {};
    if (Array.isArray(t.allowlist)) p.trust.allowlist = t.allowlist.map(String);
    if (Array.isArray(t.deny_skills)) p.trust.denySkills = t.deny_skills.map(String);
    if (Array.isArray(t.deny_publishers)) p.trust.denyPublishers = t.deny_publishers.map(String);
    const at = t.auto_threshold ?? {};
    if (typeof at.min_installs === "number") p.trust.autoThreshold.minInstalls = at.min_installs;
    if (typeof at.require_clean_scan === "boolean") p.trust.autoThreshold.requireCleanScan = at.require_clean_scan;
    if (typeof t.auto_install === "boolean") p.trust.autoInstall = t.auto_install;

    const s = y.scan ?? {};
    if (Array.isArray(s.deny_if_contains)) p.scan.denyIfContains = s.deny_if_contains.map(String);
    if (typeof s.max_archive_kb === "number") p.scan.maxArchiveKb = s.max_archive_kb;

    const l = y.log ?? {};
    if (typeof l.path === "string") p.log.path = expandHome(l.path);
    if (typeof l.retention_days === "number") p.log.retentionDays = l.retention_days;
  } catch {
    return defaultPolicy();
  }
  return p;
}

// The public verdict: the decision table (verdictFor, below) behind the one
// gate that decides whether an `auto` is allowed to stand.
export function decide(c: Candidate, scan: ScanResult, p: Policy): PolicyDecision {
  const verdict = verdictFor(c, scan, p);
  // The single gate over every `auto` the table can produce: with
  // `trust.auto_install` off (the default) nothing installs without the
  // user's yes. The verdict is still computed in full, and a branch added to
  // verdictFor() later cannot slip past this. `deny` is untouched: the knob
  // lowers what may happen unattended, never raises it.
  const gated: PolicyDecision =
    verdict.decision === "auto" && !p.trust.autoInstall
      ? { decision: "ask", reason: `auto-install is off; ${verdict.reason}` }
      : verdict;

  // An `ask` reason opens with the action ("needs your yes — ...") because
  // a bare fact ("publisher X not allowlisted") in a row reads as a verdict
  // against the package, and rows read that way were never asked about.
  // `deny` keeps the plain fact: there is no action to name.
  return gated.decision === "ask" ? { decision: "ask", reason: `needs your yes — ${gated.reason}` } : gated;
}

// The decision table, in order: deny_skills / deny_publishers -> deny;
// dirty scan -> deny; estimated installs -> ask; scan advisories -> ask;
// allowlisted publisher WITH a clean scan -> auto; installs >= min_installs
// with a clean scan -> auto; otherwise ask. The scan and the
// estimated-installs check both outrank the allowlist: a trusted publisher's
// repo can still be compromised or contain a skill nobody has actually
// installed.
//
// Not exported, and every caller reaches it through decide(): a new `auto`
// branch here is gated by construction, which is the whole point of the split.
function verdictFor(c: Candidate, scan: ScanResult, p: Policy): PolicyDecision {
  if (p.trust.denySkills.includes(c.pkg)) {
    return { decision: "deny", reason: `${c.pkg} is in deny_skills` };
  }
  if (p.trust.denyPublishers.includes(c.publisher)) {
    return { decision: "deny", reason: `publisher ${c.publisher} is in deny_publishers` };
  }
  // The allowlist lowers the install threshold; it never waives the scan. A
  // compromised commit in a trusted repository is the likeliest attack here.
  if (scan.status === "dirty") {
    return { decision: "deny", reason: `scan: ${scan.findings.slice(0, 3).join("; ") || "dirty"}` };
  }
  // An estimated count is a guess from sibling skills. Auto-installing on a
  // guess is self-deception, however large the guess.
  if (c.estimated) {
    return { decision: "ask", reason: `no real install count (${c.installs} estimated from siblings)` };
  }
  // Popularity says nothing about content: measured across the registry, the
  // rate of pattern hits in real code is identical above and below the install
  // threshold. An advisory therefore outranks the threshold.
  if (scan.advisories.length) {
    return { decision: "ask", reason: `scan advisory: ${scan.advisories.slice(0, 3).join("; ")}` };
  }
  // Allowlisted, but the scan must still be clean. `dirty` was denied above;
  // this catches the absence of a verdict (`unknown`, `unavailable`,
  // `skipped`), which maps to ask, never auto: an unscanned package from a
  // trusted publisher is exactly the compromised-commit case the allowlist
  // cannot see. The allowlist waives the install-count threshold below, and
  // only that.
  if (p.trust.allowlist.includes(c.publisher)) {
    // `require_clean_scan: false` already waives the verdict for the
    // threshold branch below; honouring it here keeps allowlisted publishers
    // from being held to a stricter standard than strangers.
    if (scan.status === "clean" || !p.trust.autoThreshold.requireCleanScan) {
      return {
        decision: "auto",
        reason: `publisher ${c.publisher} is allowlisted` + (scan.status === "clean" ? ", scan clean" : ""),
      };
    }
    return {
      decision: "ask",
      reason: `publisher ${c.publisher} is allowlisted but scan is ${scan.status}`,
    };
  }

  const { minInstalls, requireCleanScan } = p.trust.autoThreshold;
  const enough = c.installs >= minInstalls;
  if (enough && (scan.status === "clean" || !requireCleanScan)) {
    return {
      decision: "auto",
      reason: `${c.installs} installs >= ${minInstalls}` + (scan.status === "clean" ? ", scan clean" : ""),
    };
  }
  return {
    decision: "ask",
    reason: enough ? "scan unavailable" : `publisher ${c.publisher} not allowlisted`,
  };
}
