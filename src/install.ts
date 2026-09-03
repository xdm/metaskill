import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, singleLine } from "./frontmatter.js";
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

// Wraps `skills add <pkg> -g -y` (spec 4.2.6 / 4.4). Both callers now pass an
// explicit 120s — `install` and `find` alike, since the unattended path was
// measured timing out at 20.17s under the old 20s default and it is the one
// nobody is watching. On timeout the caller downgrades the candidate to
// `ask`; it never blocks the hook longer. Records the install in
// ~/.metaskill/skills-lock.json,
// `domain` and all — the (already-normalised) query phrase that found it, via
// `install`'s own `--matched` flag, or nothing for a manual install that
// passed none. `metaskill list` shows it under MATCHED, and it is also read
// back: find.ts's alreadyPresent() compares a later query against this exact
// field to short-circuit a repeat of the phrase that found this skill.
export async function installSkill(
  pkg: string,
  domain: string | undefined,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  // The caller's budget wins. The env var is the default under it — the seam
  // tests use to prove an explicit budget is the one actually in force — and
  // the spec's original 20s is the default under that.
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
      // Single-line at the boundary: this value is written to the lock and
      // printed in `Installed X (vY)`, and a block scalar can now hold a
      // newline. The parser keeps the file's own shape; the consumer states
      // what it can display.
      version = singleLine(parseFrontmatter(fs.readFileSync(skillMdPath, "utf8")).version);
    } catch {
      /* fine — version stays unknown */
    }
  }

  addLockEntry({ pkg, skill, installedAt: new Date().toISOString(), version, domain });

  return { ok: true, pkg, skillMdPath, version };
}
