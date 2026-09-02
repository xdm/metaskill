import { cachePath } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./store.js";
import type { CacheFile } from "./types.js";

const EMPTY: CacheFile = { discovery: {} };

export function readCache(): CacheFile {
  const c = readJsonFile<Partial<CacheFile>>(cachePath(), {});
  return { discovery: c.discovery ?? {} };
}

export function writeCache(cache: CacheFile): void {
  writeJsonFile(cachePath(), cache);
}

export function emptyCache(): CacheFile {
  return structuredClone(EMPTY);
}
