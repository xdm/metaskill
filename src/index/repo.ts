import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "../frontmatter.js";
import { walkDir } from "../scan.js";
import type { RepoMeta } from "./types.js";

const execFileP = promisify(execFile);

// Same cap as the runtime scanner: past this the repo is not worth a build
// slot, and the caller falls back to a description-only record.
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface RepoSkill {
  dir: string; // absolute path to the skill directory
  rel: string; // path inside the repo, posix separators
  name: string;
  description: string;
  license?: string;
  version?: string;
}

export interface RepoSnapshot {
  root: string; // absolute path to the extracted repo root
  cleanup(): void;
}

export interface RepoOpts {
  fetchImpl?: typeof fetch;
  maxDownloadBytes?: number;
  tmpBase?: string;
  token?: string; // GITHUB_TOKEN in CI; raises the API limit from 60/h to 5000/h
}

// One archive per repository yields every SKILL.md and the file content the
// scan needs, so a repo costs one request instead of one per skill.
export async function fetchRepoArchive(source: string, opts: RepoOpts = {}): Promise<RepoSnapshot | null> {
  const [owner, repo] = source.split("/");
  if (!owner || !repo) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxDownload = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const tmp = fs.mkdtempSync(path.join(opts.tmpBase ?? os.tmpdir(), "metaskill-index-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

  try {
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      cleanup();
      return null;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxDownload) {
        cleanup();
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }

    const tarPath = path.join(tmp, "archive.tar.gz");
    fs.writeFileSync(tarPath, Buffer.concat(chunks));
    const extractDir = path.join(tmp, "x");
    fs.mkdirSync(extractDir);
    await execFileP("tar", ["-xzf", tarPath, "-C", extractDir], { timeout: 120_000 });

    // GitHub archives wrap everything in a single <repo>-<ref> directory.
    const entries = fs.readdirSync(extractDir);
    const root = entries.length === 1 ? path.join(extractDir, entries[0]!) : extractDir;
    return { root, cleanup };
  } catch {
    cleanup();
    return null;
  }
}

export function findSkillDirs(root: string): RepoSkill[] {
  const out: RepoSkill[] = [];
  for (const e of walkDir(root)) {
    if (e.isDir || path.basename(e.abs) !== "SKILL.md") continue;
    let fm: Record<string, string>;
    try {
      fm = parseFrontmatter(fs.readFileSync(e.abs, "utf8"));
    } catch {
      continue; // unreadable file, not a skill we can describe
    }
    const name = fm.name;
    if (!name) continue; // the registry indexes by frontmatter name; no name, no record
    const dir = path.dirname(e.abs);
    out.push({
      dir,
      rel: path.relative(root, dir).split(path.sep).join("/"),
      name,
      description: fm.description ?? "",
      license: fm.license,
      version: fm.version,
    });
  }
  return out;
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": "metaskill-indexer",
    accept: "application/vnd.github+json",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// Repo-level credibility signals. On their own they rank skills poorly
// against install counts, so they exist to inform the question shown to a
// user, never to drive an automatic decision.
export async function fetchRepoMeta(source: string, opts: RepoOpts = {}): Promise<RepoMeta> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${source}`, {
      headers: ghHeaders(opts.token),
    });
    if (!res.ok) return {};
    const d = (await res.json()) as { stargazers_count?: unknown; pushed_at?: unknown };
    return {
      stars: typeof d.stargazers_count === "number" ? d.stargazers_count : undefined,
      pushedAt: typeof d.pushed_at === "string" ? d.pushed_at.slice(0, 10) : undefined,
    };
  } catch {
    return {};
  }
}

// Fallback for repositories whose archive is missing or over the cap: the tree
// gives every SKILL.md path in one call, and a raw fetch of each gives the
// description. No file content, so these records stay unscanned.
export async function fetchSkillsViaTree(
  source: string,
  opts: RepoOpts = {},
): Promise<Omit<RepoSkill, "dir">[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let paths: string[];
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
      headers: ghHeaders(opts.token),
    });
    if (!res.ok) return [];
    const d = (await res.json()) as { tree?: { path?: unknown }[] };
    paths = (d.tree ?? [])
      .map((t) => (typeof t.path === "string" ? t.path : ""))
      .filter((p) => p.endsWith("SKILL.md"));
  } catch {
    return [];
  }

  const out: Omit<RepoSkill, "dir">[] = [];
  for (const p of paths) {
    try {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${source}/HEAD/${p}`);
      if (!res.ok) continue;
      const fm = parseFrontmatter(await res.text());
      if (!fm.name) continue;
      out.push({
        rel: p.slice(0, -"/SKILL.md".length),
        name: fm.name,
        description: fm.description ?? "",
        license: fm.license,
        version: fm.version,
      });
    } catch {
      /* one unreadable file, keep going */
    }
  }
  return out;
}
