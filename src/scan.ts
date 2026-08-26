import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "./frontmatter.js";
import type { Candidate, Policy, ScanResult } from "./types.js";

const execFileP = promisify(execFile);

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // whole-repo tarball hard cap
const MAX_CONTENT_SCAN_BYTES = 512 * 1024; // per-file content grep cap

export interface ParsedPkg {
  github: boolean;
  owner?: string;
  repo?: string;
  skill: string;
}

export function parsePkg(pkg: string): ParsedPkg {
  const at = pkg.lastIndexOf("@");
  const base = at > 0 ? pkg.slice(0, at) : pkg;
  const skill = at > 0 ? pkg.slice(at + 1) : pkg;
  const m = base.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m || base.includes(".")) return { github: false, skill }; // registry hosts like modelscope.cn
  return { github: true, owner: m[1]!, repo: m[2]!, skill };
}

export interface ScanOpts {
  fetchImpl?: typeof fetch;
  tmpBase?: string;
  maxDownloadBytes?: number;
}

function* walk(dir: string, base = dir): Generator<{ abs: string; rel: string; isDir: boolean }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isSymbolicLink()) continue; // never follow links out of the archive
    if (e.isDirectory()) {
      yield { abs, rel, isDir: true };
      yield* walk(abs, base);
    } else if (e.isFile()) {
      yield { abs, rel, isDir: false };
    }
  }
}

function findSkillDir(root: string, skill: string): string | null {
  const target = skill.toLowerCase();
  const byFrontmatter: string[] = [];
  for (const e of walk(root)) {
    if (e.isDir && path.basename(e.abs).toLowerCase() === target) {
      if (fs.existsSync(path.join(e.abs, "SKILL.md"))) return e.abs;
    }
    if (!e.isDir && path.basename(e.abs) === "SKILL.md") {
      try {
        const fm = parseFrontmatter(fs.readFileSync(e.abs, "utf8"));
        if ((fm.name ?? "").toLowerCase() === target) byFrontmatter.push(path.dirname(e.abs));
      } catch {
        /* unreadable candidate file — skip */
      }
    }
  }
  return byFrontmatter[0] ?? null;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 1024).includes(0);
}

// Static scan of the skill's directory inside the repo tarball, BEFORE any
// `skills add` runs (spec §5). Patterns from policy.scan.deny_if_contains:
//   - "hooks/"     -> matches a path segment (any dir named hooks)
//   - ".mcp.json"  -> matches a file name
//   - "curl "      -> matches file content (text files only)
// Result "unavailable" means we could not verify — policy maps that to ask,
// never to auto (outside the allowlist).
export async function scanCandidate(c: Candidate, policy: Policy, opts: ScanOpts = {}): Promise<ScanResult> {
  const parsed = parsePkg(c.pkg);
  if (!parsed.github) return { status: "unavailable", findings: ["not a github package; cannot fetch archive"] };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxDownload = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const tmp = fs.mkdtempSync(path.join(opts.tmpBase ?? os.tmpdir(), "metaskill-scan-"));
  try {
    const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/HEAD`;
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok || !res.body) return { status: "unavailable", findings: [`download failed: HTTP ${res.status}`] };

    const tarPath = path.join(tmp, "archive.tar.gz");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxDownload) {
        return { status: "unavailable", findings: ["repository archive exceeds download cap"] };
      }
      chunks.push(Buffer.from(chunk));
    }
    fs.writeFileSync(tarPath, Buffer.concat(chunks));

    const extractDir = path.join(tmp, "x");
    fs.mkdirSync(extractDir);
    await execFileP("tar", ["-xzf", tarPath, "-C", extractDir], { timeout: 30_000 });

    const skillDir = findSkillDir(extractDir, parsed.skill);
    if (!skillDir) return { status: "unavailable", findings: [`skill "${parsed.skill}" not found in archive`] };

    const findings: string[] = [];
    const pathPatterns = policy.scan.denyIfContains.filter((p) => p.endsWith("/"));
    const namePatterns = policy.scan.denyIfContains.filter((p) => !p.endsWith("/") && p.startsWith("."));
    const contentPatterns = policy.scan.denyIfContains.filter((p) => !p.endsWith("/") && !p.startsWith("."));

    let sizeBytes = 0;
    for (const e of walk(skillDir)) {
      const relPosix = e.rel.split(path.sep).join("/");
      if (e.isDir) {
        for (const p of pathPatterns) {
          if (`${relPosix}/`.includes(p)) findings.push(`forbidden path: ${relPosix}/ matches "${p}"`);
        }
        continue;
      }
      sizeBytes += fs.statSync(e.abs).size;
      for (const p of namePatterns) {
        if (path.basename(e.abs) === p) findings.push(`forbidden file: ${relPosix}`);
      }
      if (contentPatterns.length && fs.statSync(e.abs).size <= MAX_CONTENT_SCAN_BYTES) {
        const buf = fs.readFileSync(e.abs);
        if (!looksBinary(buf)) {
          const text = buf.toString("utf8");
          for (const p of contentPatterns) {
            if (text.includes(p)) findings.push(`"${p}" found in ${relPosix}`);
          }
        }
      }
    }

    if (sizeBytes > policy.scan.maxArchiveKb * 1024) {
      findings.push(`skill directory ${Math.round(sizeBytes / 1024)} KB exceeds max_archive_kb ${policy.scan.maxArchiveKb}`);
    }

    return findings.length ? { status: "dirty", findings } : { status: "clean", findings: [] };
  } catch (err) {
    return { status: "unavailable", findings: [`scan error: ${(err as Error).message}`] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
