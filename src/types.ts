export interface Candidate {
  pkg: string; // e.g. "anthropics/skills@xlsx" or "modelscope.cn@minimax-xlsx"
  publisher: string; // "anthropics" / "modelscope.cn"
  skillName: string; // "xlsx"
  installs: number;
  url: string;
}

export type ScanStatus = "clean" | "dirty" | "unavailable" | "skipped";

export interface ScanResult {
  status: ScanStatus;
  findings: string[];
  // Pattern hits in a skill's prose. They do not deny — documentation that
  // mentions a command is not the same as code that runs one — but they never
  // pass silently either: policy routes them to the user with the line shown.
  advisories: string[];
}

export type Decision = "auto" | "ask" | "deny";

export interface PolicyDecision {
  decision: Decision;
  reason: string;
}

export interface Policy {
  version: number;
  classifier: {
    trivialMaxChars: number;
  };
  trust: {
    allowlist: string[];
    autoThreshold: { minInstalls: number; requireCleanScan: boolean };
    denyPublishers: string[];
  };
  scan: {
    denyIfContains: string[];
    maxArchiveKb: number;
  };
  domains: Record<string, string>;
  customDomains: import("./taxonomy.js").DomainDef[];
  log: { path: string; retentionDays: number };
}

export interface InstalledSkill {
  name: string;
  dir: string;
  description?: string;
  scope: "global" | "project";
}

export interface LockEntry {
  pkg: string;
  skill: string;
  installedAt: string;
  version?: string;
  domain?: string;
}

export interface InstallResult {
  ok: boolean;
  pkg: string;
  skillMdPath?: string;
  version?: string;
  timedOut?: boolean;
  error?: string;
}

export interface HeuristicResult {
  domains: string[]; // prompt-derived + merged stack domains
  confidence: "high" | "low";
  trivial: boolean;
  stackDomains: string[]; // stack-derived, informational
}

export interface DiscoveredLogItem {
  pkg: string;
  installs: number;
  publisher: string;
  decision: Decision;
  scan: ScanStatus;
}

export interface RouteLogEntry {
  ts: string;
  session: string;
  prompt_hash: string;
  domains: string[];
  covered: string[];
  discovered: DiscoveredLogItem[];
  installed: string[];
  latency_ms: number;
}

export interface CacheFile {
  domainMap: Record<string, string>; // domain -> installed skill name
  discovery: Record<string, { ts: string; candidates: Candidate[] }>;
}

export interface StateFile {
  lastSyncTs?: string;
}
