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

export function loadIndex(file?: string): IndexFile | null {
  if (file) return readOne(file);
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
  const hits: Hit[] = [];
  for (let i = 0; i < N; i++) {
    const doc = docs[i]!;
    if (!doc.length) continue;
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
    if (score > 0) hits.push({ record: index.skills[i]!, score });
  }

  // Tie-break on pkg so equal scores never reorder between runs.
  hits.sort((a, b) => b.score - a.score || a.record.pkg.localeCompare(b.record.pkg));
  return hits.slice(0, limit);
}
