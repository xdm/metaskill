import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { agentsSkillsDir, claudeUserSkillsDir, projectSkillsDir } from "./paths.js";
import type { InstalledSkill } from "./types.js";

function scanDir(dir: string, scope: "global" | "project"): InstalledSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledSkill[] = [];
  for (const e of entries) {
    // symlinks included on purpose: `skills add -g` symlinks into ~/.claude/skills
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const skillDir = path.join(dir, e.name);
    const md = path.join(skillDir, "SKILL.md");
    try {
      if (!fs.existsSync(md)) continue;
      const fm = parseFrontmatter(fs.readFileSync(md, "utf8"));
      out.push({ name: fm.name ?? e.name, dir: skillDir, description: fm.description, scope });
    } catch {
      /* unreadable skill dir — skip, never break the hook */
    }
  }
  return out;
}

export function listInstalledSkills(cwd: string): InstalledSkill[] {
  const seen = new Map<string, InstalledSkill>();
  // project wins over user-global, which wins over the agents store
  for (const s of [
    ...scanDir(projectSkillsDir(cwd), "project"),
    ...scanDir(claudeUserSkillsDir(), "global"),
    ...scanDir(agentsSkillsDir(), "global"),
  ]) {
    if (!seen.has(s.name)) seen.set(s.name, s);
  }
  return [...seen.values()];
}
