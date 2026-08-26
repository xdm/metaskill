import { lockPath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";
import type { LockEntry } from "./types.js";

export type LockFile = Record<string, LockEntry>; // keyed by pkg

export function readLock(): LockFile {
  return readJsonFile<LockFile>(lockPath(), {});
}

export function writeLock(lock: LockFile): void {
  writeJsonFile(lockPath(), lock);
}

export function addLockEntry(entry: LockEntry): void {
  const lock = readLock();
  lock[entry.pkg] = entry;
  writeLock(lock);
}
