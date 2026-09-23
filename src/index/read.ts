import fs from "node:fs";
import path from "node:path";
import { metaskillHome, packageRoot } from "../paths.js";
import type { ScanResult } from "../types.js";
import { INDEX_SCHEMA_VERSION, type IndexFile, type IndexRecord } from "./types.js";

export interface Hit {
  record: IndexRecord;
  score: number;
  // BM25 score divided by the best score this query could reach (the sum of
  // its terms' IDF). Raw BM25 grows with query length and corpus size; this
  // ratio reads the same against the packaged snapshot and the full index,
  // which is what makes it worth printing per row. It can exceed 1: the
  // term-frequency factor saturates above the IDF sum.
  //
  // It says how much of the query a row matched, not whether the row fits
  // the task — a rare word ranks its wrong sense just as high. Fit is judged
  // from the description; this number only gates what `find` prints under
  // the rows (MIN_ASK_RELEVANCE).
  relevance: number;
}

// The one threshold that decides what `find` prints under the rows: at or
// above it a ready-made question, below it silence. Two zones, no middle
// band in which the model decides whether to ask — a slot that permits
// skipping is used to skip.
//
// Measured against the packaged snapshot on the everyday and calibration
// query fixtures (see DESIGN.md): 0.55 is the highest value that admits every
// real query that deserved a question (their minimum was 0.56), and going
// lower stops discriminating at all. Most rows above the line are homonyms
// no threshold can separate; the description check in find.ts catches
// those. Exported so the protocol text quotes this exact value.
export const MIN_ASK_RELEVANCE = 0.55;

// Single characters carry no signal and version fragments would dominate
// rare-term scoring.
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// Shared by `find` (its query) and `install`/`decline` (`--matched`), so the
// phrase recorded in the lock is exactly the form a later `find` compares
// against.
export function normaliseQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function indexPath(): string {
  return path.join(metaskillHome(), "index.json");
}

// The packaged snapshot is the offline floor: a fresh install can look skills
// up before `sync` has ever run.
export function snapshotPath(): string {
  return path.join(packageRoot(), "index-snapshot.json");
}

// A schemaVersion this build does not understand is rejected outright: the
// fields policy reads (`scan`, `installs`, `estimated`) could mean something
// else, and refreshIndex must never replace a readable index with one it
// cannot interpret.
function readOne(file: string): IndexFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IndexFile;
    if (!isIndexFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isIndexFile(parsed: unknown): parsed is IndexFile {
  const f = parsed as IndexFile | null;
  return !!f && Array.isArray(f.skills) && f.schemaVersion === INDEX_SCHEMA_VERSION;
}

// The index carries a scan verdict per skill, so the runtime never downloads
// a tarball to learn one. `unknown` (no verdict) is `unavailable` to policy,
// never clean. The arrays are defaulted: readOne validates the file, not each
// record, and a hand-edited index can omit them.
export function scanResultFromIndex(r: IndexRecord): ScanResult {
  return {
    status: r.scan === "unknown" ? "unavailable" : r.scan,
    findings: r.scanFindings ?? [],
    advisories: r.scanAdvisories ?? [],
  };
}

// METASKILL_INDEX is for test isolation: a sandboxed HOME can move
// indexPath(), but the packaged snapshot always resolves under the running
// package. When set it is the only file consulted.
export function loadIndex(file?: string): IndexFile | null {
  if (file) return readOne(file);
  const override = process.env.METASKILL_INDEX;
  if (override && override.trim().length > 0) return readOne(override);
  return readOne(indexPath()) ?? readOne(snapshotPath());
}

const K1 = 1.5;
const B = 0.75;

export function search(index: IndexFile, query: string, limit = 5): Hit[] {
  const qTerms = tokenize(query);
  if (!qTerms.length) return [];

  const docs = index.skills.map((r) => tokenize(`${r.description ?? ""} ${r.name}`));
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1);

  // Document frequency for query terms only — the full dictionary is never needed.
  const df = new Map<string, number>();
  for (const d of docs) {
    const seen = new Set(d);
    for (const t of qTerms) if (seen.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const N = docs.length;
  const idfOf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  // The denominator of `relevance`.
  const maxScore = qTerms.reduce((a, t) => a + idfOf(t), 0);
  // One hit per pkg (the highest-scoring row): the index can carry a package
  // more than once.
  const bestByPkg = new Map<string, Hit>();
  for (let i = 0; i < N; i++) {
    const doc = docs[i]!;
    if (!doc.length) continue;
    // A record with no pkg cannot be installed, printed or asked about, and
    // one such record must not take the whole batch down later.
    const record = index.skills[i]!;
    if (!record.pkg) continue;
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t);
      if (!f) continue;
      score += idfOf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgLen)));
    }
    if (score <= 0) continue;
    const existing = bestByPkg.get(record.pkg);
    if (!existing || score > existing.score) {
      bestByPkg.set(record.pkg, { record, score, relevance: maxScore > 0 ? score / maxScore : 0 });
    }
  }

  const hits = [...bestByPkg.values()];
  // Tie-break on pkg so equal scores never reorder between runs.
  hits.sort((a, b) => b.score - a.score || (a.record.pkg ?? "").localeCompare(b.record.pkg ?? ""));
  return hits.slice(0, limit);
}

// Exact pkg lookup for the install and update paths. Among duplicate rows a
// dirty one wins: the safe reading of ambiguous data.
export function findByPkg(index: IndexFile, pkg: string): IndexRecord | null {
  let hit: IndexRecord | null = null;
  for (const r of index.skills) {
    if (r.pkg !== pkg) continue;
    if (r.scan === "dirty") return r;
    hit ??= r;
  }
  return hit;
}
