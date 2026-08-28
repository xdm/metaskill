import { defaultPolicy } from "../policy.js";
import type { Policy } from "../types.js";
import { scanDirectory } from "../scan.js";
import { joinRepo, type ScannedSkill } from "./join.js";
import { fetchRepoArchive, fetchRepoMeta, fetchSkillsViaTree, findSkillDirs } from "./repo.js";
import { sweepRegistry } from "./registry.js";
import { INDEX_SCHEMA_VERSION, type IndexFile, type IndexRecord, type RegistrySkill, type RepoMeta } from "./types.js";

export interface BuildOpts {
  fetchImpl?: typeof fetch;
  grams?: readonly string[];
  tmpBase?: string;
  scanPolicy?: Policy["scan"];
  token?: string;
  now?: Date;
  onProgress?: (msg: string) => void;
}

// Last resort when neither the archive nor the tree answered: the registry
// still knows the skill exists and how popular it is. A description-less
// record cannot be matched by lexical search, but omitting it silently would
// hide a real skill, and "unknown" keeps it off the automatic path.
function registryOnlyRecords(source: string, registry: RegistrySkill[], meta: RepoMeta): IndexRecord[] {
  return registry.map((r) => ({
    name: r.name,
    source,
    pkg: `${source}@${r.name}`,
    description: "",
    installs: r.installs,
    installsPrior: null,
    estimated: false,
    repoStars: meta.stars,
    repoPushedAt: meta.pushedAt,
    // No file was ever read for a registry-only stub, so it cannot be a
    // root-level skill by any positive evidence — false, not unknown.
    atRepoRoot: false,
    scan: "unknown" as const,
    scanFindings: [],
    scanAdvisories: [],
  }));
}

export async function buildIndex(opts: BuildOpts = {}): Promise<IndexFile> {
  const scanPolicy = opts.scanPolicy ?? defaultPolicy().scan;
  // The sweep is ~143 sequential requests and can run up to ~48 minutes worst
  // case; without this, CI emits nothing until it either finishes or times out.
  const registry = await sweepRegistry({
    fetchImpl: opts.fetchImpl,
    grams: opts.grams,
    onProgress: (gram, total) => opts.onProgress?.(`sweep ${gram}: ${total} skills so far`),
  });

  const bySource = new Map<string, RegistrySkill[]>();
  for (const r of registry) {
    const list = bySource.get(r.source);
    if (list) list.push(r);
    else bySource.set(r.source, [r]);
  }
  opts.onProgress?.(`${registry.length} skills across ${bySource.size} repositories`);

  const repoOpts = { fetchImpl: opts.fetchImpl, tmpBase: opts.tmpBase, token: opts.token };
  const skills: IndexRecord[] = [];

  for (const [source, entries] of bySource) {
    const meta = await fetchRepoMeta(source, repoOpts);
    const snap = await fetchRepoArchive(source, repoOpts);

    if (snap) {
      try {
        const scanned: ScannedSkill[] = findSkillDirs(snap.root).map((s) => {
          const verdict = scanDirectory(s.dir, scanPolicy);
          // scanDirectory only ever returns clean or dirty; anything else would
          // be a new status we must not silently treat as safe.
          const scan = verdict.status === "clean" ? "clean" : verdict.status === "dirty" ? "dirty" : "unknown";
          return { ...s, scan, scanFindings: verdict.findings, scanAdvisories: verdict.advisories };
        });
        skills.push(...joinRepo(source, scanned, entries, meta));
        opts.onProgress?.(`${source}: ${scanned.length} skills`);
      } catch (err) {
        // One repository's files must not sink a run over hundreds of them.
        // Nothing has been pushed for this repo at this point, so falling back
        // to stubs cannot duplicate records — and "unknown" keeps them off the
        // automatic path, which an unscanned repository has not earned.
        skills.push(...registryOnlyRecords(source, entries, meta));
        opts.onProgress?.(`${source}: scan failed (${(err as Error).message}), ${entries.length} records from the registry only`);
      } finally {
        snap.cleanup();
      }
      continue;
    }

    // Fallback: the tree gives descriptions but no file content, so no scan.
    const viaTree = await fetchSkillsViaTree(source, repoOpts);
    if (viaTree.length) {
      const scanned: ScannedSkill[] = viaTree.map((s) => ({
        ...s,
        dir: "",
        scan: "unknown" as const,
        scanFindings: [],
        scanAdvisories: [],
      }));
      skills.push(...joinRepo(source, scanned, entries, meta));
      opts.onProgress?.(`${source}: ${scanned.length} skills via tree, unscanned`);
      continue;
    }

    skills.push(...registryOnlyRecords(source, entries, meta));
    opts.onProgress?.(`${source}: unreachable, ${entries.length} records from the registry only`);
  }

  return {
    schemaVersion: INDEX_SCHEMA_VERSION,
    builtAt: (opts.now ?? new Date()).toISOString(),
    skillCount: skills.length,
    repoCount: bySource.size,
    skills,
  };
}
