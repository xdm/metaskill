import { describe, expect, it } from "vitest";
import { buildSnapshot } from "../src/index/snapshot.js";
import type { IndexFile } from "../src/index/types.js";

const full: IndexFile = {
  schemaVersion: 1, builtAt: "2026-08-31T10:10:37.836Z", skillCount: 3, repoCount: 2,
  skills: [
    { name: "a", source: "o/r", pkg: "o/r@a", description: "x".repeat(500), installs: 900,
      installsPrior: null, estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [] },
    { name: "b", source: "o/r", pkg: "o/r@b", description: "short", installs: null,
      installsPrior: 400, estimated: true, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [] },
    { name: "c", source: "p/q", pkg: "p/q@c", description: "another", installs: 5,
      installsPrior: null, estimated: false, atRepoRoot: false, scan: "dirty", scanFindings: ["eval("], scanAdvisories: [] },
  ],
};

describe("buildSnapshot", () => {
  it("keeps only records with a real install count", () => {
    expect(buildSnapshot(full).skills.map((s) => s.pkg)).toEqual(["o/r@a", "p/q@c"]);
  });

  it("truncates descriptions", () => {
    expect(buildSnapshot(full).skills[0]!.description.length).toBe(200);
  });

  it("recomputes the envelope counts", () => {
    const s = buildSnapshot(full);
    expect(s.skillCount).toBe(2);
    expect(s.repoCount).toBe(2);
  });

  it("keeps the scan verdict and findings that policy reads", () => {
    expect(buildSnapshot(full).skills[1]!.scanFindings).toEqual(["eval("]);
  });
});
