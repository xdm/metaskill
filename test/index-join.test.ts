import { describe, expect, it } from "vitest";
import { joinRepo, medianInstalls, type ScannedSkill } from "../src/index/join.js";
import type { RegistrySkill } from "../src/index/types.js";

function scanned(name: string, over: Partial<ScannedSkill> = {}): ScannedSkill {
  return {
    dir: `/tmp/${name}`,
    rel: `skills/${name}`,
    name,
    description: `desc ${name}`,
    scan: "clean",
    scanFindings: [],
    scanAdvisories: [],
    ...over,
  };
}

const reg = (name: string, installs: number, id = name): RegistrySkill => ({ name, id, source: "o/r", installs });

describe("medianInstalls", () => {
  it("returns the median for odd and even counts", () => {
    expect(medianInstalls([10, 30, 20])).toBe(20);
    expect(medianInstalls([10, 20, 30, 40])).toBe(25);
  });

  it("returns null for an empty list", () => {
    expect(medianInstalls([])).toBeNull();
  });
});

describe("joinRepo", () => {
  it("attaches registry installs and marks the skill as not estimated", () => {
    const [r] = joinRepo("o/r", [scanned("a")], [reg("a", 5000)]);
    expect(r).toMatchObject({
      pkg: "o/r@a",
      installs: 5000,
      installsPrior: null,
      estimated: false,
    });
  });

  it("names the package by the CLI's install name, and keeps the frontmatter name for display", () => {
    // `skills add o/r@<selector>` matches the selector against the CLI's
    // sanitised install name, and that is also the directory it installs
    // into. 345 live records carried a frontmatter name with spaces or
    // capitals, and every command printed for them split in the shell.
    const [r] = joinRepo("o/r", [scanned("LinkedIn Automation")], []);
    expect(r).toMatchObject({ pkg: "o/r@linkedin-automation", name: "LinkedIn Automation" });
  });

  it("joins registry installs by the registry's slug, which the install name matches", () => {
    // The registry lowercases the name it reports ("linkedin automation") and
    // slugs the id ("linkedin-automation"); a join on the raw frontmatter
    // name missed every such skill and marked it estimated.
    const [r] = joinRepo("o/r", [scanned("LinkedIn Automation")], [reg("linkedin automation", 512, "linkedin-automation")]);
    expect(r).toMatchObject({ installs: 512, estimated: false });
  });

  it("gives unknown skills the median of known siblings and marks them estimated", () => {
    const out = joinRepo(
      "o/r",
      [scanned("a"), scanned("b"), scanned("ghost")],
      [reg("a", 100), reg("b", 300)],
    );
    const ghost = out.find((r) => r.name === "ghost")!;
    expect(ghost.installs).toBeNull();
    expect(ghost.installsPrior).toBe(200);
    expect(ghost.estimated).toBe(true);
  });

  it("leaves the prior null when no sibling has an install count", () => {
    const [r] = joinRepo("o/r", [scanned("solo")], []);
    expect(r).toMatchObject({ installs: null, installsPrior: null, estimated: true });
  });

  it("carries prose advisories onto the record alongside the verdict", () => {
    const out = joinRepo(
      "o/r",
      [scanned("a", { scan: "clean", scanAdvisories: ['"curl " found in SKILL.md'] })],
      [reg("a", 1)],
    );
    expect(out[0]).toMatchObject({ scan: "clean", scanAdvisories: ['"curl " found in SKILL.md'] });
  });

  it("carries scan verdict, findings, and repo metadata onto every record", () => {
    const out = joinRepo(
      "o/r",
      [scanned("a", { scan: "dirty", scanFindings: ['"curl " found in run.sh'] })],
      [reg("a", 1)],
      { stars: 1423, pushedAt: "2026-08-26" },
    );
    expect(out[0]).toMatchObject({
      scan: "dirty",
      scanFindings: ['"curl " found in run.sh'],
      repoStars: 1423,
      repoPushedAt: "2026-08-26",
    });
  });

  it("ignores registry entries for skills that are not in the repo", () => {
    const out = joinRepo("o/r", [scanned("a")], [reg("a", 1), reg("vanished", 999)]);
    expect(out).toHaveLength(1);
  });

  it("marks a skill whose directory is the repo root, and leaves nested skills unmarked", () => {
    const out = joinRepo(
      "o/r",
      [scanned("root-skill", { rel: "" }), scanned("nested")],
      [reg("root-skill", 10), reg("nested", 20)],
    );
    const byName = Object.fromEntries(out.map((r) => [r.name, r]));
    expect(byName["root-skill"]!.atRepoRoot).toBe(true);
    expect(byName.nested!.atRepoRoot).toBe(false);
  });
});
