import path from "node:path";
import { metaskillHome } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";

// Where a no to `Ask the user: Install <pkg> ...?` is kept, so `find` does
// not put the same package to the user again. Keyed by package, not by
// phrase: the repeats arrive under different phrasings of the same task. It
// expires, because the registry moves and a month-old no should not hide a
// skill for good; a later `install <pkg>` removes the entry.
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
// next write; nothing reads them.
export function activeDeclines(now: Date = new Date()): DeclinesFile {
  const out: DeclinesFile = {};
  for (const [pkg, e] of Object.entries(readDeclines())) {
    const until = Date.parse(e?.until ?? "");
    if (Number.isFinite(until) && until > now.getTime()) out[pkg] = e;
  }
  return out;
}
