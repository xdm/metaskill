import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCache, writeCache } from "../src/cache.js";
import { coverage, listInstalledSkills } from "../src/inventory.js";
import { addLockEntry, readLock } from "../src/lock.js";
import { defaultPolicy } from "../src/policy.js";
import { readState, writeState } from "../src/state.js";

let home: string;
let project: string;
const savedHome = process.env.HOME;
const savedMs = process.env.METASKILL_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-inv-"));
  project = path.join(home, "proj");
  fs.mkdirSync(project, { recursive: true });
  process.env.HOME = home; // os.homedir() honors $HOME on POSIX
  process.env.METASKILL_HOME = path.join(home, ".metaskill");
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
  if (savedMs === undefined) delete process.env.METASKILL_HOME;
  else process.env.METASKILL_HOME = savedMs;
});

function addSkill(baseDir: string, name: string, frontmatter?: string) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), frontmatter ?? `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

describe("inventory (spec 4.2.3)", () => {
  it("lists skills from project, ~/.claude and ~/.agents, deduped, symlinks included", () => {
    addSkill(path.join(home, ".agents", "skills"), "xlsx");
    // symlink into ~/.claude/skills the way `skills add -g` does
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join(home, ".agents", "skills", "xlsx"),
      path.join(home, ".claude", "skills", "xlsx"),
    );
    addSkill(path.join(home, ".claude", "skills"), "python-best-practices");
    addSkill(path.join(project, ".claude", "skills"), "local-skill");
    const skills = listInstalledSkills(project);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["local-skill", "python-best-practices", "xlsx"]);
  });

  it("survives broken frontmatter (real-world SKILL.md files break strict YAML)", () => {
    addSkill(
      path.join(home, ".claude", "skills"),
      "broken",
      "---\ndescription: Use this: with a colon, {braces} and: more\n---\nbody\n",
    );
    const skills = listInstalledSkills(project);
    expect(skills.map((s) => s.name)).toContain("broken"); // falls back to dir name
  });

  it("coverage: policy override, domainMap, exact and substring name matches", () => {
    addSkill(path.join(home, ".claude", "skills"), "xlsx");
    addSkill(path.join(home, ".claude", "skills"), "python-best-practices");
    addSkill(path.join(home, ".claude", "skills"), "company-crawler");
    const installed = listInstalledSkills(project);
    const policy = defaultPolicy();
    policy.domains.scraping = "mycompany/skills@company-crawler";
    const cache = { domainMap: { docker: "python-best-practices" }, discovery: {} };
    const cov = coverage(["xlsx", "python", "scraping", "docker", "seo"], installed, policy, cache);
    expect(cov.covered).toEqual({
      xlsx: "xlsx", // exact name
      python: "python-best-practices", // substring
      scraping: "company-crawler", // policy override
      docker: "python-best-practices", // domainMap
    });
    expect(cov.uncovered).toEqual(["seo"]);
  });
});

describe("stores round-trip", () => {
  it("cache, lock and state read back what was written; missing files -> empty", () => {
    expect(readCache()).toEqual({ domainMap: {}, discovery: {} });
    writeCache({ domainMap: { xlsx: "xlsx" }, discovery: {} });
    expect(readCache().domainMap.xlsx).toBe("xlsx");

    expect(readLock()).toEqual({});
    addLockEntry({ pkg: "a/b@c", skill: "c", installedAt: "2026-08-26T00:00:00Z", version: "1" });
    expect(readLock()["a/b@c"]!.skill).toBe("c");

    expect(readState()).toEqual({});
    writeState({ lastSyncTs: "2026-08-26T00:00:00Z" });
    expect(readState().lastSyncTs).toBe("2026-08-26T00:00:00Z");
  });
});
