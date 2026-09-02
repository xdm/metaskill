import fs from "node:fs";
import path from "node:path";
import { metaskillHome, packageRoot } from "../paths.js";
import type { ScanResult } from "../types.js";
import { INDEX_SCHEMA_VERSION, type IndexFile, type IndexRecord } from "./types.js";

export interface Hit {
  record: IndexRecord;
  score: number;
  // The BM25 score as a fraction of the best score this query could possibly
  // reach (the sum of its terms' IDF). Raw BM25 is not comparable between
  // queries or between corpora — it grows with query length and with log(N),
  // so the same phrase scores ~0.4 against a 1-record index and ~10 against
  // the 4,831-skill snapshot, and higher again against the 43,714-skill index
  // `sync` downloads. This ratio is stable across all three, which is what
  // makes it worth printing: `find` shows it per row so the model comparing
  // rows reads the same number whichever index the user happens to have. It
  // is not bounded by 1: BM25's term-frequency factor saturates at K1+1, so a
  // document that repeats every query term lands above it.
  //
  // It is a signal, never a gate. A fixed floor was tried and removed: the
  // junk and capability distributions measured against the shipped snapshot
  // OVERLAP (junk max 1.298, capability min 0.850), so no threshold separates
  // them, and any floor high enough to reject junk silenced almost every real
  // query. Judging relevance is the model's job; reporting it is this
  // number's.
  relevance: number;
}

// Single characters carry no signal and blow up the term dictionary; version
// fragments ("1", "2") would otherwise dominate rare-term scoring.
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

// Shared by `find` (the query it searches with) and `install` (`--matched`,
// so a confirmed install's lock entry records the phrase in exactly the form
// `find`'s reinstall check compares against — see find.ts's alreadyPresent).
// One function, not two copies: an unsanitised `--matched` would either never
// match a later `find`'s normalised query, or, if over-broad, permanently
// short-circuit unrelated future finds onto this one skill. Lives here rather
// than in either command module so neither has to import the other.
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

// A file whose schemaVersion is not the one this build understands is not an
// index as far as the runtime is concerned: a future builder may repurpose a
// field this code reads (`scan`, `installs`, `estimated` all drive policy), so
// guessing at it is how a stale binary auto-installs on a verdict it
// misread. Rejecting it here also stops refreshIndex from replacing a good
// local index with one it cannot interpret.
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

// The index already carries a scan verdict per skill, so no runtime path has
// to download a tarball to find out (spec 7 Defect 2). `unknown` in the index
// means the scanner never got a verdict, which is `unavailable` to policy —
// never "clean".
//
// loadIndex/readOne validates the file, never the shape of each record, so a
// hand-edited or corrupted index.json can omit these arrays entirely (or
// carry an explicit `null`) — default them, or a dirty scan
// (policy.ts's `scan.findings.slice`) or an advisory check
// (`scan.advisories.length`) throws before the caller prints anything.
export function scanResultFromIndex(r: IndexRecord): ScanResult {
  return {
    status: r.scan === "unknown" ? "unavailable" : r.scan,
    findings: r.scanFindings ?? [],
    advisories: r.scanAdvisories ?? [],
  };
}

// METASKILL_INDEX exists for test isolation: a sandboxed HOME can redirect
// indexPath() (via METASKILL_HOME), but snapshotPath() always resolves under
// the running package's own root, which a test cannot relocate. Set, it is
// the ONLY file consulted — missing or unreadable means null, never a
// silent fall-through to whatever snapshot happens to sit in packageRoot().
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
  // The best score any document could reach for this query: every term
  // matched, before the term-frequency factor. The denominator of `relevance`.
  const maxScore = qTerms.reduce((a, t) => a + idfOf(t), 0);
  // Dedup by pkg, keeping the highest-scoring row: index.json can carry the
  // same package more than once (repeat scans, registry sweep overlap), and
  // a caller-facing top-N must not repeat a package to fill it.
  const bestByPkg = new Map<string, Hit>();
  for (let i = 0; i < N; i++) {
    const doc = docs[i]!;
    if (!doc.length) continue;
    // A record with no pkg can't be installed, displayed, logged, or asked
    // about — it has no business being a hit at all. Filtering here, before
    // it ever reaches a Hit, means one corrupted record can no longer take
    // out every well-formed candidate ranked beside it downstream (a thrown
    // recordToCandidate mid-`.map()` used to discard the whole batch).
    // Falsy, not `?? `/nullish: an empty-string pkg is exactly as useless.
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
  // Tie-break on pkg so equal scores never reorder between runs. `?? ""`
  // guards a record whose `pkg` a corrupted or hand-edited index.json
  // dropped — well-formed records (the overwhelming case) compare exactly
  // as before, since neither side is ever nullish for them.
  hits.sort((a, b) => b.score - a.score || (a.record.pkg ?? "").localeCompare(b.record.pkg ?? ""));
  return hits.slice(0, limit);
}

// Exact pkg lookup for the update paths, which know the package and need its
// verdict — not a ranked search. The index can carry duplicate pkg rows, so a
// dirty row wins over a clean one: the safe reading of ambiguous data.
export function findByPkg(index: IndexFile, pkg: string): IndexRecord | null {
  let hit: IndexRecord | null = null;
  for (const r of index.skills) {
    if (r.pkg !== pkg) continue;
    if (r.scan === "dirty") return r;
    hit ??= r;
  }
  return hit;
}
