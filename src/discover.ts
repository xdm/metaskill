import { execFile } from "node:child_process";
import { skillsCmd } from "./paths.js";
import { readCache, writeCache } from "./cache.js";
import type { DomainDef } from "./taxonomy.js";
import type { Candidate } from "./types.js";

export type Runner = (cmd: string[], timeoutMs: number) => Promise<{ stdout: string }>;

const defaultRunner: Runner = (cmd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    execFile(
      bin!,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve({ stdout })),
    );
  });

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function parseInstalls(s: string): number {
  const m = s.trim().match(/^([\d.,]+)\s*([kKmM])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  if (Number.isNaN(n)) return 0;
  const suffix = m[2]?.toLowerCase();
  return Math.round(n * (suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1));
}

export function publisherOf(pkg: string): string {
  return pkg.includes("/") ? pkg.split("/")[0]! : pkg.split("@")[0]!;
}

// Parses non-TTY `skills find` output (verified against v1.5.23):
//   owner/repo@skill 158.3K installs
//   └ https://skills.sh/owner/repo/skill
export function parseFindOutput(text: string): Candidate[] {
  const out: Candidate[] = [];
  let last: Candidate | null = null;
  for (const rawLine of stripAnsi(text).split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^(\S+@\S+)\s+([\d.,]+[kKmM]?)\s+installs?$/);
    if (m) {
      const pkg = m[1]!;
      last = {
        pkg,
        publisher: publisherOf(pkg),
        skillName: pkg.slice(pkg.lastIndexOf("@") + 1),
        installs: parseInstalls(m[2]!),
        url: "",
      };
      out.push(last);
      continue;
    }
    const u = line.match(/^└\s+(https?:\/\/\S+)$/);
    if (u && last) last.url = u[1]!;
  }
  return out;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface DiscoverOpts {
  now?: Date;
  timeoutMs?: number;
  runner?: Runner;
}

// Queries are short capability terms (taxonomy queries, or a phrase the
// in-session model derived) — never the raw prompt (spec 4.2.4). Results are
// cached 24h per key; a failed lookup falls back to a stale cache entry
// rather than erroring the hook.
async function discoverRaw(cacheKey: string, query: string, opts: DiscoverOpts): Promise<Candidate[]> {
  const now = opts.now ?? new Date();
  const cache = readCache();
  const hit = cache.discovery[cacheKey];
  if (hit && now.getTime() - Date.parse(hit.ts) < CACHE_TTL_MS) return hit.candidates;

  const runner = opts.runner ?? defaultRunner;
  try {
    const { stdout } = await runner([...skillsCmd(), "find", query], opts.timeoutMs ?? 10_000);
    const candidates = parseFindOutput(stdout);
    cache.discovery[cacheKey] = { ts: now.toISOString(), candidates };
    writeCache(cache);
    return candidates;
  } catch {
    return hit?.candidates ?? [];
  }
}

export async function discover(domain: DomainDef, opts: DiscoverOpts = {}): Promise<Candidate[]> {
  return discoverRaw(domain.id, domain.query, opts);
}

export async function discoverByQuery(query: string, opts: DiscoverOpts = {}): Promise<Candidate[]> {
  return discoverRaw(`q:${query}`, query, opts);
}
