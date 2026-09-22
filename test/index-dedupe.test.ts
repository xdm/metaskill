import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeIndex } from "../src/index/dedupe.js";
import type { IndexRecord } from "../src/index/types.js";

function rec(source: string, name: string, description: string, installs: number | null = null): IndexRecord {
  return {
    name, source, pkg: `${source}@${name}`, description, installs,
    installsPrior: null, estimated: installs === null, atRepoRoot: false,
    scan: "clean", scanFindings: [], scanAdvisories: [],
  };
}

describe("dedupeIndex", () => {
  it("collapses records that share a name and a description across repositories", () => {
    const { skills, removed } = dedupeIndex([
      rec("anthropics/skills", "xlsx", "Read and write Excel workbooks.", 158400),
      rec("aiskillstore/marketplace", "xlsx", "Read and write Excel workbooks.", 237),
      rec("o/r", "other", "Something else."),
    ]);
    expect(skills.map((s) => s.pkg)).toEqual(["anthropics/skills@xlsx", "o/r@other"]);
    expect(removed).toBe(1);
  });

  it("keeps the copy with the higher real install count, whichever repository holds it", () => {
    // Evidence of use beats provenance: anthropics/skills is mirrored by 21
    // repositories, and a provenance-first rule dropped 8 of its 20 skills.
    const { skills } = dedupeIndex([
      rec("small/origin", "alpha", "Alpha does alpha things.", null),
      rec("agg/marketplace", "alpha", "Alpha does alpha things.", 900),
      rec("anthropics/skills", "xlsx", "Read and write Excel workbooks.", 158400),
      rec("agg/marketplace", "xlsx", "Read and write Excel workbooks.", 237),
    ]);
    expect(skills.map((s) => s.pkg)).toEqual(["agg/marketplace@alpha", "anthropics/skills@xlsx"]);
  });

  it("among copies nobody installs, keeps the repository that shares skills with the fewest others", () => {
    // A mirror copies from many origins; an origin is copied by a few
    // mirrors. With no install count to go on, the partner count is the
    // signal that tells them apart.
    const mirror = "agg/marketplace";
    const { skills } = dedupeIndex([
      rec("a/one", "alpha", "Alpha does alpha things."),
      rec(mirror, "alpha", "Alpha does alpha things."),
      rec("b/two", "beta", "Beta does beta things."),
      rec(mirror, "beta", "Beta does beta things."),
      rec("c/three", "gamma", "Gamma does gamma things."),
      rec(mirror, "gamma", "Gamma does gamma things."),
    ]);
    expect(skills.map((s) => s.pkg).sort()).toEqual(["a/one@alpha", "b/two@beta", "c/three@gamma"]);
  });

  it("breaks a full tie on the source name, so sweep order never decides", () => {
    const { skills } = dedupeIndex([
      rec("fork/superpowers", "linkedin-content", "Write linkedin content.", 400),
      rec("obra/superpowers", "linkedin-content", "Write linkedin content.", 9000),
      rec("z/z", "zeta", "Zeta."),
      rec("a/a", "zeta", "Zeta."),
    ]);
    expect(skills.map((s) => s.pkg)).toEqual(["obra/superpowers@linkedin-content", "a/a@zeta"]);
  });

  it("compares descriptions case- and whitespace-insensitively, and names case-insensitively", () => {
    const { skills } = dedupeIndex([
      rec("o/r", "Xlsx", "Read  and write\nExcel workbooks. "),
      rec("m/m", "xlsx", "read and write excel workbooks."),
    ]);
    expect(skills).toHaveLength(1);
  });

  it("never collapses records with no description — a blank says nothing about identity", () => {
    const { skills, removed } = dedupeIndex([rec("o/r", "deploy", ""), rec("m/m", "deploy", "  "), rec("n/n", "deploy", "")]);
    expect(skills).toHaveLength(3);
    expect(removed).toBe(0);
  });

  it("keeps a name shared by two different skills", () => {
    const { skills } = dedupeIndex([
      rec("o/r", "deploy", "Deploy to Cloudflare Workers."),
      rec("m/m", "deploy", "Deploy a Django app to Heroku."),
    ]);
    expect(skills).toHaveLength(2);
  });

  it("keeps first-seen order among the survivors", () => {
    const { skills } = dedupeIndex([
      rec("o/r", "b", "B."), rec("o/r", "a", "A."), rec("z/z", "b", "B."), rec("o/r", "c", "C."),
    ]);
    expect(skills.map((s) => s.name)).toEqual(["b", "a", "c"]);
  });
});

describe("index-dedupe CLI (the publish gate's like-with-like count)", () => {
  it("prints the deduplicated skill count of an index file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-dedupe-cli-"));
    const file = path.join(dir, "index.json");
    const skills = [rec("o/r", "x", "X."), rec("m/m", "x", "X."), rec("o/r", "y", "Y.")];
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, builtAt: "t", skillCount: 3, repoCount: 2, skills }));
    const out = execFileSync(process.execPath, [path.resolve(__dirname, "..", "dist", "index-dedupe.js"), file], { encoding: "utf8" });
    expect(out.trim()).toBe("2");
  });
});
