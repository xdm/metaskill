import fs from "node:fs";
import os from "node:os";
import YAML from "yaml";
import { defaultLogPath, policyPath } from "./paths.js";
import type { Candidate, Policy, PolicyDecision, ScanResult } from "./types.js";

export function defaultPolicy(): Policy {
  return {
    version: 1,
    classifier: { llm: "auto", model: "claude-haiku-4-5", trivialMaxChars: 40 },
    trust: {
      allowlist: ["anthropics", "vercel-labs"],
      autoThreshold: { minInstalls: 5000, requireCleanScan: true },
      denyPublishers: [],
    },
    scan: {
      denyIfContains: ["hooks/", ".mcp.json", "curl ", "wget ", "eval(", "process.env", "os.environ"],
      maxArchiveKb: 2048,
    },
    domains: {},
    customDomains: [],
    log: { path: defaultLogPath(), retentionDays: 90 },
  };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? os.homedir() + p.slice(1) : p;
}

// Reads ~/.metaskill/metaskill.yaml (snake_case, spec 4.5) over built-in
// defaults. Any read/parse failure -> defaults; the hook must never die on
// a broken config.
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
    const c = y.classifier ?? {};
    if (c.llm === "auto" || c.llm === "off" || c.llm === "always") p.classifier.llm = c.llm;
    if (typeof c.model === "string") p.classifier.model = c.model;
    if (typeof c.trivial_max_chars === "number") p.classifier.trivialMaxChars = c.trivial_max_chars;

    const t = y.trust ?? {};
    if (Array.isArray(t.allowlist)) p.trust.allowlist = t.allowlist.map(String);
    if (Array.isArray(t.deny_publishers)) p.trust.denyPublishers = t.deny_publishers.map(String);
    const at = t.auto_threshold ?? {};
    if (typeof at.min_installs === "number") p.trust.autoThreshold.minInstalls = at.min_installs;
    if (typeof at.require_clean_scan === "boolean") p.trust.autoThreshold.requireCleanScan = at.require_clean_scan;

    const s = y.scan ?? {};
    if (Array.isArray(s.deny_if_contains)) p.scan.denyIfContains = s.deny_if_contains.map(String);
    if (typeof s.max_archive_kb === "number") p.scan.maxArchiveKb = s.max_archive_kb;

    if (y.domains && typeof y.domains === "object" && !Array.isArray(y.domains)) {
      p.domains = Object.fromEntries(Object.entries(y.domains).map(([k, v]) => [k, String(v)]));
    }

    if (Array.isArray(y.custom_domains)) {
      p.customDomains = y.custom_domains
        .filter((d: any) => d && typeof d.id === "string" && /^[a-z0-9-]{2,32}$/.test(d.id))
        .map((d: any) => ({
          id: d.id,
          keywords: Array.isArray(d.keywords) ? d.keywords.map(String) : [],
          extensions: Array.isArray(d.extensions) ? d.extensions.map(String) : [],
          query: typeof d.query === "string" && d.query.trim() ? d.query : d.id,
        }));
    }

    const l = y.log ?? {};
    if (typeof l.path === "string") p.log.path = expandHome(l.path);
    if (typeof l.retention_days === "number") p.log.retentionDays = l.retention_days;
  } catch {
    return defaultPolicy();
  }
  return p;
}

// Spec 4.5 decision table, in order. deny_publishers wins over everything;
// nothing outside the allowlist auto-installs without a clean scan (unless
// the operator explicitly sets require_clean_scan: false).
export function decide(c: Candidate, scan: ScanResult, p: Policy): PolicyDecision {
  if (p.trust.denyPublishers.includes(c.publisher)) {
    return { decision: "deny", reason: `publisher ${c.publisher} is in deny_publishers` };
  }
  if (p.trust.allowlist.includes(c.publisher)) {
    return { decision: "auto", reason: `publisher ${c.publisher} is allowlisted` };
  }
  if (scan.status === "dirty") {
    return { decision: "deny", reason: `scan: ${scan.findings.slice(0, 3).join("; ") || "dirty"}` };
  }
  // Popularity says nothing about content: measured across the registry, the
  // rate of pattern hits in real code is identical above and below the install
  // threshold. An advisory therefore outranks the threshold.
  if (scan.advisories.length) {
    return { decision: "ask", reason: `scan advisory: ${scan.advisories.slice(0, 3).join("; ")}` };
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
