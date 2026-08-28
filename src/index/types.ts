// Shapes shared by the CI indexer and the runtime reader that consumes the
// index it produces. This file is the contract between them; keep it free of I/O.

export interface RegistrySkill {
  name: string; // frontmatter name, which is what the registry indexes by
  source: string; // "owner/repo"
  installs: number;
}

export type IndexScanStatus = "clean" | "dirty" | "unknown";

export interface IndexRecord {
  name: string;
  source: string;
  pkg: string; // "owner/repo@name" — what `skills add` takes
  description: string;
  license?: string;
  version?: string;
  // null, never 0, when the registry does not know this skill: the difference
  // between "nobody installed it" and "we have no data" drives policy.
  installs: number | null;
  installsPrior: number | null; // median installs of known siblings in the repo
  estimated: boolean; // true when installs is null and only the prior exists
  repoStars?: number;
  repoPushedAt?: string; // YYYY-MM-DD
  // True when the skill's SKILL.md sits at the repository root, so its scan
  // covered the whole repository rather than a skill-scoped subdirectory —
  // needed to keep whole-repo false positives from reading as pattern noise.
  atRepoRoot: boolean;
  scan: IndexScanStatus;
  scanFindings: string[];
}

// Repo-level signals, declared here so the fetcher and the joiner cannot drift.
export interface RepoMeta {
  stars?: number;
  pushedAt?: string; // YYYY-MM-DD
}

export interface IndexFile {
  schemaVersion: number;
  builtAt: string; // ISO 8601
  skillCount: number;
  repoCount: number;
  skills: IndexRecord[];
}

export const INDEX_SCHEMA_VERSION = 1;
