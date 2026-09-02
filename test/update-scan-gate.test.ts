import { describe, expect, it } from "vitest";
import { blockedByScan } from "../src/commands/update.js";
import type { IndexFile } from "../src/index/types.js";

function idx(scan: "clean" | "dirty" | "unknown"): IndexFile {
  return {
    schemaVersion: 1, builtAt: "2026-08-31T00:00:00.000Z", skillCount: 1, repoCount: 1,
    skills: [{ name: "x", source: "anthropics/skills", pkg: "anthropics/skills@x", description: "d",
      installs: 9, installsPrior: null, estimated: false, atRepoRoot: false,
      scan, scanFindings: scan === "dirty" ? ["eval("] : [], scanAdvisories: [] }],
  };
}

describe("blockedByScan", () => {
  it("blocks a dirty package even from an allowlisted publisher", () => {
    expect(blockedByScan(idx("dirty"), "anthropics/skills@x")).toBe("eval(");
  });

  it("allows a clean package", () => {
    expect(blockedByScan(idx("clean"), "anthropics/skills@x")).toBeNull();
  });

  it("allows a package the index does not know — only a positive dirty verdict blocks", () => {
    expect(blockedByScan(idx("clean"), "someone/else@y")).toBeNull();
  });

  it("allows when there is no index at all", () => {
    expect(blockedByScan(null, "anthropics/skills@x")).toBeNull();
  });
});
