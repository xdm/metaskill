import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readCache, writeCache } from "./cache.js";
import { parseFrontmatter } from "./frontmatter.js";
import { addLockEntry } from "./lock.js";
import { agentsSkillsDir, claudeUserSkillsDir, skillsCmd } from "./paths.js";
import type { InstallResult } from "./types.js";

export interface InstallOpts {
  timeoutMs?: number;
}

function skillNameOf(pkg: string): string {
  return pkg.slice(pkg.lastIndexOf("@") + 1);
}

export function locateInstalled(skill: string): string | undefined {
  // ~/.claude/skills first — that's the path Claude reads; ~/.agents/skills
  // is where `skills add -g` physically puts files (symlinked into the former).
  for (const dir of [claudeUserSkillsDir(), agentsSkillsDir()]) {
    const p = path.join(dir, skill, "SKILL.md");
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* dir unreadable */
    }
  }
  return undefined;
}

// Wraps `skills add <pkg> -g -y` (spec 4.2.6 / 4.4). 20s default timeout —
// on timeout the caller downgrades the candidate to `ask`, it never blocks
// the hook longer. Records the install in ~/.metaskill/skills-lock.json and
// maps domain -> skill in the cache so inventory covers it next time.
export async function installSkill(
  pkg: string,
  domain: string | undefined,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  // Env override exists for tests and ops tuning; spec default is 20s.
  const timeoutMs = opts.timeoutMs ?? Number(process.env.METASKILL_INSTALL_TIMEOUT_MS ?? 20_000);
  const skill = skillNameOf(pkg);

  const run = new Promise<{ ok: boolean; timedOut: boolean; error?: string }>((resolve) => {
    const [bin, ...args] = [...skillsCmd(), "add", pkg, "-g", "-y"];
    execFile(bin!, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      if (!err) return resolve({ ok: true, timedOut: false });
      const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
      resolve({ ok: false, timedOut, error: err.message });
    });
  });

  const res = await run;
  if (!res.ok) return { ok: false, pkg, timedOut: res.timedOut, error: res.error };

  const skillMdPath = locateInstalled(skill);
  let version: string | undefined;
  if (skillMdPath) {
    try {
      version = parseFrontmatter(fs.readFileSync(skillMdPath, "utf8")).version;
    } catch {
      /* fine — version stays unknown */
    }
  }

  addLockEntry({ pkg, skill, installedAt: new Date().toISOString(), version, domain });
  if (domain) {
    const cache = readCache();
    cache.domainMap[domain] = skill;
    writeCache(cache);
  }

  return { ok: true, pkg, skillMdPath, version };
}
