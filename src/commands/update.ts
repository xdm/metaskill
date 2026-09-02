import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { publisherOf } from "../discover.js";
import { parseFrontmatter } from "../frontmatter.js";
import { findByPkg, loadIndex } from "../index/read.js";
import type { IndexFile } from "../index/types.js";
import { readLock, writeLock } from "../lock.js";
import { agentsSkillsDir, claudeUserSkillsDir, skillsCmd } from "../paths.js";
import { loadPolicy } from "../policy.js";

export interface UpdateFlags {
  force?: boolean;
}

function run(cmd: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    execFile(bin!, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

function installedVersion(skill: string): string | undefined {
  for (const dir of [claudeUserSkillsDir(), agentsSkillsDir()]) {
    try {
      return parseFrontmatter(fs.readFileSync(path.join(dir, skill, "SKILL.md"), "utf8")).version;
    } catch {
      /* try next dir */
    }
  }
  return undefined;
}

// Spec §7 Defect 1 applies to updating, not only to installing: the allowlist
// lowers the install threshold, it never waives the scan. Only a positive
// `dirty` verdict blocks — an unknown package or a missing index leaves the
// existing behaviour intact, matching decide()'s own treatment of `unknown`.
export function blockedByScan(index: IndexFile | null, pkg: string): string | null {
  if (!index) return null;
  const r = findByPkg(index, pkg);
  if (!r || r.scan !== "dirty") return null;
  // Same corruption risk find.ts's scanFromIndex guards against: the type
  // says string[], but loadIndex/readOne never validates a record's shape,
  // so a hand-edited or corrupted index.json can carry scanFindings as null
  // or omit it — indexing [0] on either throws instead of reporting "dirty".
  return Array.isArray(r.scanFindings) ? r.scanFindings[0] ?? "dirty" : "dirty";
}

// Manual `metaskill update [names...]` (spec 4.4). Same trust rules as sync:
// allowlisted publishers update freely; others need --force (that's the `ask`
// tier); deny_publishers are skipped no matter what; and — ahead of both,
// unbypassable by --force exactly like deny_publishers — a package the local
// index scanned dirty is never updated.
export async function updateCommand(names: string[], flags: UpdateFlags): Promise<number> {
  const policy = loadPolicy();
  const lock = readLock();
  let entries = Object.values(lock);
  if (names.length) entries = entries.filter((e) => names.includes(e.skill) || names.includes(e.pkg));
  if (!entries.length) {
    process.stdout.write("Nothing to update (no matching entries in skills-lock.json).\n");
    return 0;
  }

  const index = loadIndex();
  const approved = entries.filter((e) => {
    const finding = blockedByScan(index, e.pkg);
    if (finding) {
      process.stderr.write(`skip ${e.skill}: index scan is dirty (${finding}) — no flag bypasses a dirty scan.\n`);
      return false;
    }
    const pub = publisherOf(e.pkg);
    if (policy.trust.denyPublishers.includes(pub)) {
      process.stderr.write(`skip ${e.skill}: publisher ${pub} is denied (no flag bypasses deny).\n`);
      return false;
    }
    if (!policy.trust.allowlist.includes(pub) && !flags.force) {
      process.stderr.write(`skip ${e.skill}: publisher ${pub} not allowlisted — re-run with --force to update it.\n`);
      return false;
    }
    return true;
  });
  if (!approved.length) return 1;

  try {
    await run([...skillsCmd(), "update", ...approved.map((e) => e.skill), "-g", "-y"], 180_000);
  } catch (err) {
    process.stderr.write(`update failed: ${(err as Error).message}\n`);
    return 1;
  }

  for (const e of approved) {
    lock[e.pkg] = { ...e, version: installedVersion(e.skill) ?? e.version };
  }
  writeLock(lock);
  process.stdout.write(`Updated: ${approved.map((e) => e.skill).join(", ")}\n`);
  return 0;
}
