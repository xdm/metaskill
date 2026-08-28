import type { RepoSkill } from "./repo.js";
import type { IndexRecord, IndexScanStatus, RegistrySkill, RepoMeta } from "./types.js";

export interface ScannedSkill extends RepoSkill {
  scan: IndexScanStatus;
  scanFindings: string[];
}

export function medianInstalls(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

// The repo is the unit of truth: a skill exists because its SKILL.md exists.
// Registry entries only contribute install counts, and a registry entry with
// no matching file is stale data we drop rather than invent a record for.
export function joinRepo(
  source: string,
  scanned: ScannedSkill[],
  registry: RegistrySkill[],
  meta: RepoMeta = {},
): IndexRecord[] {
  const installsByName = new Map(registry.map((r) => [r.name, r.installs]));
  // Siblings with real numbers are the only honest basis for an estimate:
  // same author, same repo, same review standard.
  const prior = medianInstalls(scanned.map((s) => installsByName.get(s.name)).filter((v): v is number => typeof v === "number"));

  return scanned.map((s) => {
    const installs = installsByName.get(s.name) ?? null;
    return {
      name: s.name,
      source,
      pkg: `${source}@${s.name}`,
      description: s.description,
      license: s.license,
      version: s.version,
      installs,
      installsPrior: installs === null ? prior : null,
      estimated: installs === null,
      repoStars: meta.stars,
      repoPushedAt: meta.pushedAt,
      atRepoRoot: s.rel === "",
      scan: s.scan,
      scanFindings: s.scanFindings,
    };
  });
}
