import { describe, expect, it } from "vitest";
import { recordToCandidate } from "../src/commands/find.js";
import type { IndexRecord } from "../src/index/types.js";

function rec(over: Partial<IndexRecord> = {}): IndexRecord {
  return {
    name: "xlsx", source: "anthropics/skills", pkg: "anthropics/skills@xlsx",
    description: "Read and write Excel workbooks.", installs: 158400,
    installsPrior: null, estimated: false, atRepoRoot: false,
    scan: "clean", scanFindings: [], scanAdvisories: [], ...over,
  };
}

describe("recordToCandidate", () => {
  it("carries the publisher, name and real install count", () => {
    const c = recordToCandidate(rec());
    expect(c).toMatchObject({ publisher: "anthropics", skillName: "xlsx", installs: 158400, estimated: false });
  });

  it("substitutes the sibling prior and marks estimated when installs is null", () => {
    const c = recordToCandidate(rec({ installs: null, installsPrior: 460, estimated: true }));
    expect(c.installs).toBe(460);
    expect(c.estimated).toBe(true);
  });

  it("uses zero when neither a count nor a prior exists", () => {
    const c = recordToCandidate(rec({ installs: null, installsPrior: null, estimated: true }));
    expect(c.installs).toBe(0);
    expect(c.estimated).toBe(true);
  });
});
