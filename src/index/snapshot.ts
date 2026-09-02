import type { IndexFile, IndexRecord } from "./types.js";

// The npm tarball is 79.5 kB; the full index is 3.83 MB gzipped. 89% of the
// index is `estimated`, which can only ever produce an `ask`, so the offline
// floor ships the 11% that carry a real install count (~0.34 MB gzipped).
// `sync` upgrades to the full index on the user machine.
export function buildSnapshot(full: IndexFile, opts: { descriptionChars?: number } = {}): IndexFile {
  const max = opts.descriptionChars ?? 200;
  const skills: IndexRecord[] = full.skills
    .filter((s) => s.installs !== null)
    .map((s) => ({ ...s, description: (s.description ?? "").slice(0, max) }));
  return {
    schemaVersion: full.schemaVersion,
    builtAt: full.builtAt,
    skillCount: skills.length,
    repoCount: new Set(skills.map((s) => s.source)).size,
    skills,
  };
}
