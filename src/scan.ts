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

// Documentation is not executed. A skill whose instructions say to run `curl`
// was being denied as though it ran it: measured over the whole registry, 66%
// of dirty verdicts came only from a content pattern appearing in prose, and
// 88% of `curl ` hits were in markdown. Content patterns therefore skip these
// extensions. Path and file-name patterns, and the size limit, still apply —
// a forbidden file is forbidden wherever it sits.
const PROSE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst"]);

function isProse(file: string): boolean {
  return PROSE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

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

export function* walkDir(dir: string, base = dir): Generator<{ abs: string; rel: string; isDir: boolean }> {
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
      yield* walkDir(abs, base);
    } else if (e.isFile()) {
      yield { abs, rel, isDir: false };
    }
  }
}

function findSkillDir(root: string, skill: string): string | null {
  const target = skill.toLowerCase();
  const byFrontmatter: string[] = [];
  for (const e of walkDir(root)) {
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

// The pattern rules, applied to a directory already on disk. Shared with the
// CI indexer so the runtime scan and the indexed verdict can never disagree.
// Patterns come from policy.scan.deny_if_contains and take one of three shapes:
//   - "hooks/"     -> matches a path segment (any dir named hooks)
//   - ".mcp.json"  -> matches a file name
//   - "curl "      -> matches file content; a hit in prose becomes an
//                     advisory instead of a denial (see ScanResult)
export function scanDirectory(dir: string, scanPolicy: Policy["scan"]): ScanResult {
  const findings: string[] = [];
  const advisories: string[] = [];
  const pathPatterns = scanPolicy.denyIfContains.filter((p) => p.endsWith("/"));
  const namePatterns = scanPolicy.denyIfContains.filter((p) => !p.endsWith("/") && p.startsWith("."));
  const contentPatterns = scanPolicy.denyIfContains.filter((p) => !p.endsWith("/") && !p.startsWith("."));

  let sizeBytes = 0;
  for (const e of walkDir(dir)) {
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
        const sink = isProse(e.abs) ? advisories : findings;
        for (const p of contentPatterns) {
          if (text.includes(p)) sink.push(`"${p}" found in ${relPosix}`);
        }
      }
    }
  }

  if (sizeBytes > scanPolicy.maxArchiveKb * 1024) {
    findings.push(
      `skill directory ${Math.round(sizeBytes / 1024)} KB exceeds max_archive_kb ${scanPolicy.maxArchiveKb}`,
    );
  }

  return findings.length
    ? { status: "dirty", findings, advisories }
    : { status: "clean", findings: [], advisories };
}

// Fetches the repo archive, extracts it to a scratch directory, locates the
// named skill inside it, and delegates to scanDirectory for the pattern
// rules — all before `skills add` ever runs, so a verdict exists before
// anything reaches disk in its real location.
// Result "unavailable" means we could not verify — policy maps that to ask,
// never to auto (outside the allowlist).
export async function scanCandidate(c: Candidate, policy: Policy, opts: ScanOpts = {}): Promise<ScanResult> {
  const parsed = parsePkg(c.pkg);
  if (!parsed.github) return { status: "unavailable", findings: ["not a github package; cannot fetch archive"], advisories: [] };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxDownload = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const tmp = fs.mkdtempSync(path.join(opts.tmpBase ?? os.tmpdir(), "metaskill-scan-"));
  try {
    const url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/HEAD`;
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok || !res.body) return { status: "unavailable", findings: [`download failed: HTTP ${res.status}`], advisories: [] };

    const tarPath = path.join(tmp, "archive.tar.gz");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxDownload) {
        return { status: "unavailable", findings: ["repository archive exceeds download cap"], advisories: [] };
      }
      chunks.push(Buffer.from(chunk));
    }
    fs.writeFileSync(tarPath, Buffer.concat(chunks));

    const extractDir = path.join(tmp, "x");
    fs.mkdirSync(extractDir);
    await execFileP("tar", ["-xzf", tarPath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"], {
      timeout: 30_000,
    });

    const skillDir = findSkillDir(extractDir, parsed.skill);
    if (!skillDir) return { status: "unavailable", findings: [`skill "${parsed.skill}" not found in archive`], advisories: [] };

    return scanDirectory(skillDir, policy.scan);
  } catch (err) {
    return { status: "unavailable", findings: [`scan error: ${(err as Error).message}`], advisories: [] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
