import path from "node:path";
import { metaskillHome } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";

// A "no" to `Ask the user: Install <pkg> ...?` used to leave no trace: the
// next `find` with a similar phrase put the same package back on top and the
// same question to the user again — measured on the 2026-09 log as one
// package asked about on 12 mornings in a row. This file is where a no is
// kept. It is keyed by PACKAGE, not by (package, phrase): the repeats arrive
// under slightly different phrasings of the same task, and a no to a skill
// is about the skill.
//
// It expires. The registry moves — a thin skill gets a real description, an
// install count, a clean scan — and a no from a month ago should not hide it
// for good. 30 days is long enough to outlast a project's daily routine and
// short enough that nothing is buried. A successful `install <pkg>` removes
// the entry (install.ts): installing the thing is the natural undo.
export const DECLINE_DAYS = 30;

export interface DeclineEntry {
  ts: string;
  until: string;
  matched?: string;
}

export type DeclinesFile = Record<string, DeclineEntry>; // keyed by pkg

export function declinesPath(): string {
  return path.join(metaskillHome(), "declined.json");
}

export function readDeclines(): DeclinesFile {
  const raw = readJsonFile<unknown>(declinesPath(), {});
  // A hand-edited or corrupt file must never take `find` down with it.
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as DeclinesFile) : {};
}

export function addDecline(pkg: string, matched: string | undefined, now: Date = new Date()): void {
  const all = readDeclines();
  all[pkg] = {
    ts: now.toISOString(),
    until: new Date(now.getTime() + DECLINE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    ...(matched ? { matched } : {}),
  };
  writeJsonFile(declinesPath(), all);
}

export function removeDecline(pkg: string): void {
  const all = readDeclines();
  if (!(pkg in all)) return;
  delete all[pkg];
  writeJsonFile(declinesPath(), all);
}

// Only the entries still in force. Expired rows stay in the file until the
// next write — nothing reads them, and rewriting the file on every `find`
// would put a write on the hot path for nothing.
export function activeDeclines(now: Date = new Date()): DeclinesFile {
  const out: DeclinesFile = {};
  for (const [pkg, e] of Object.entries(readDeclines())) {
    const until = Date.parse(e?.until ?? "");
    if (Number.isFinite(until) && until > now.getTime()) out[pkg] = e;
  }
  return out;
}
