import fs from "node:fs";
import path from "node:path";
import { metaskillHome, packageRoot } from "../paths.js";
import type { IndexFile, IndexRecord } from "./types.js";

export interface Hit {
  record: IndexRecord;
  score: number;
}

// Single characters carry no signal and blow up the term dictionary; version
// fragments ("1", "2") would otherwise dominate rare-term scoring.
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function indexPath(): string {
  return path.join(metaskillHome(), "index.json");
}

// The packaged snapshot is the offline floor: a fresh install can look skills
// up before `sync` has ever run.
export function snapshotPath(): string {
  return path.join(packageRoot(), "index-snapshot.json");
}

function readOne(file: string): IndexFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as IndexFile;
    if (!Array.isArray(parsed.skills)) return null;
    return parsed;
  } catch {
    return null;
  }
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
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avgLen)));
    }
    if (score <= 0) continue;
    const existing = bestByPkg.get(record.pkg);
    if (!existing || score > existing.score) bestByPkg.set(record.pkg, { record, score });
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
