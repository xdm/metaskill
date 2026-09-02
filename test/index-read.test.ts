import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { search, tokenize } from "../src/index/read.js";
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
  it("ranks an on-topic skill above an unrelated one", () => {
    const hits = search(index, "excel spreadsheet", 5);
    expect(hits.length).toBeGreaterThan(0);
    const names = hits.map((h) => h.record.name.toLowerCase()).join(" ");
    expect(names).toMatch(/xlsx|excel|spreadsheet/);
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
