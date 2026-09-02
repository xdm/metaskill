import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIN_RELEVANCE, findByPkg, loadIndex, search, tokenize } from "../src/index/read.js";
import { INDEX_SCHEMA_VERSION, type IndexFile } from "../src/index/types.js";

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

describe("search: the relevance floor", () => {
  // Corpus-independence is the whole reason `relevance` exists: BM25's raw
  // score grows with log(N), so a floor set against the 4,831-skill snapshot
  // would silence every hit in a 2-record test index and let junk through
  // against the 43,714-skill index `sync` downloads.
  const tiny: IndexFile = {
    schemaVersion: 1, builtAt: "2026-09-02T00:00:00.000Z", skillCount: 1, repoCount: 1,
    skills: [{ name: "gizmo", source: "o/r", pkg: "o/r@gizmo", description: "Gizmo automation toolkit.",
               installs: 10, installsPrior: null, estimated: false, atRepoRoot: false,
               scan: "clean", scanFindings: [], scanAdvisories: [] }],
  };

  it("scores a full match above the floor in a 1-record index and in the 350-record fixture", () => {
    expect(search(tiny, "gizmo automation", 1)[0]!.relevance).toBeGreaterThanOrEqual(MIN_RELEVANCE);
    expect(search(index, "prisma postgres", 1)[0]!.relevance).toBeGreaterThanOrEqual(MIN_RELEVANCE);
  });

  it("keeps a partial match below the floor even when it is the best row available", () => {
    // No document in the fixture covers both terms of "database migration",
    // so its top hit (prisma-database-setup, which is about setup) sits at
    // ~0.52. find prints `No skills found` rather than offering the nearest
    // thing it could rank — the behaviour that stops "say hello" installing
    // whatever happens to mention "hello".
    expect(search(index, "database migration", 1)[0]!.relevance).toBeLessThan(MIN_RELEVANCE);
  });

  it("puts a hit that matched one term of a multi-term query below the floor", () => {
    // "gizmo" matches, "kubernetes" cannot — half a query is not a match.
    const h = search(tiny, "gizmo kubernetes elasticsearch", 1)[0]!;
    expect(h.relevance).toBeLessThan(MIN_RELEVANCE);
  });

  it("orders by relevance exactly as it orders by score", () => {
    // relevance divides every score for a query by the same constant, so the
    // top hit by score is always the top hit by relevance. find.ts checks
    // only hits[0].
    const hits = search(index, "react component testing", 5);
    const byRel = [...hits].sort((a, b) => b.relevance - a.relevance);
    expect(byRel.map((h) => h.record.pkg)).toEqual(hits.map((h) => h.record.pkg));
  });
});

describe("loadIndex: schemaVersion", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-schema-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function write(name: string, body: unknown): string {
    const f = path.join(dir, name);
    fs.writeFileSync(f, JSON.stringify(body));
    return f;
  }

  it("reads an index at the current schema version", () => {
    const f = write("ok.json", { ...index, schemaVersion: INDEX_SCHEMA_VERSION });
    expect(loadIndex(f)?.skills.length).toBe(index.skills.length);
  });

  it("rejects a future schema version rather than guessing at its fields", () => {
    // Every field the runtime reads off a record — scan, installs, estimated —
    // decides whether something installs unattended. A builder that repurposes
    // one must not be interpreted by a build that predates the change.
    expect(loadIndex(write("future.json", { ...index, schemaVersion: INDEX_SCHEMA_VERSION + 1 }))).toBeNull();
  });

  it("rejects an index with no schemaVersion at all", () => {
    const { schemaVersion, ...rest } = index;
    expect(loadIndex(write("none.json", rest))).toBeNull();
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
