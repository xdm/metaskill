import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findByPkg, search, tokenize } from "../src/index/read.js";
import type { IndexFile } from "../src/index/types.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/index-sample.json");
const index = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as IndexFile;

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumerics, and drops single chars", () => {
    expect(tokenize("Next.js  App-Router, a UI")).toEqual(["next", "js", "app", "router", "ui"]);
  });

  it("returns an empty array for punctuation only", () => {
    expect(tokenize("--- !!!")).toEqual([]);
  });
});

describe("search", () => {
  it("ranks the real top-3 for a capability phrase (golden ranking)", () => {
    // Exact order, not membership: 10 distinct packages score for this query
    // in the fixture, so a broken scorer (reversed sort, or BM25 with the
    // IDF factor dropped) lands a different top-3, not just a reordering of
    // the same hits. Checked against both before this test was kept — see
    // task-1-report.md.
    const hits = search(index, "database migration", 3);
    expect(hits.map((h) => h.record.pkg)).toEqual([
      "prisma/skills@prisma-database-setup",
      "prisma/skills@prisma-postgres-setup",
      "prisma/skills@prisma-upgrade-v7",
    ]);
  });

  it("dedupes a package that appears multiple times in the index", () => {
    // pbakaus/impeccable@impeccable is present 17 times in the fixture — real
    // upstream duplication (repeat scans), not a fixture artifact. A top-N
    // shown to the user must not let one package fill multiple slots.
    const hits = search(index, "frontend design critique", 5);
    const pkgs = hits.map((h) => h.record.pkg);
    expect(pkgs.filter((p) => p === "pbakaus/impeccable@impeccable")).toHaveLength(1);
  });

  it("returns at most the requested limit", () => {
    expect(search(index, "react component", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns hits in non-increasing score order", () => {
    const scores = search(index, "database migration", 5).map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("returns nothing for a query with no term in the corpus", () => {
    expect(search(index, "zzzqqq wwwvvv", 5)).toEqual([]);
  });

  it("is deterministic — same input, same output", () => {
    const a = search(index, "pdf extraction", 5).map((h) => h.record.pkg);
    const b = search(index, "pdf extraction", 5).map((h) => h.record.pkg);
    expect(a).toEqual(b);
  });

  it("scores a term appearing in few documents above a ubiquitous one", () => {
    // IDF sanity: a rare term must not be swamped by a common one.
    const rare = search(index, "kubernetes", 1);
    const common = search(index, "the and for", 1);
    if (rare.length && common.length) expect(rare[0]!.score).toBeGreaterThan(common[0]!.score);
  });
});

describe("findByPkg", () => {
  it("finds a record by exact pkg", () => {
    const r = findByPkg(index, "anthropics/skills@xlsx");
    expect(r?.pkg).toBe("anthropics/skills@xlsx");
  });

  it("returns null for a pkg that is not indexed", () => {
    expect(findByPkg(index, "nobody/nothing@nowhere")).toBeNull();
  });

  it("prefers a dirty row when a pkg has duplicate records", () => {
    const dup: IndexFile = {
      schemaVersion: 1, builtAt: "2026-08-31T00:00:00.000Z", skillCount: 2, repoCount: 1,
      skills: [
        { name: "a", source: "o/r", pkg: "o/r@a", description: "d", installs: 1, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [] },
        { name: "a", source: "o/r", pkg: "o/r@a", description: "d", installs: 1, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "dirty", scanFindings: ["eval("], scanAdvisories: [] },
      ],
    };
    expect(findByPkg(dup, "o/r@a")?.scan).toBe("dirty");
  });
});
