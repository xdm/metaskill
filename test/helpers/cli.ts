// The one CLI harness every end-to-end suite spawns through. Two suites used
// to carry their own copy of runCli and its sandbox env; a variable added to
// one (METASKILL_INDEX, METASKILL_SKIP_INDEX_REFRESH both arrived that way)
// and not the other let that suite reach the developer's real ~/.metaskill,
// or the network, without any test saying so.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");
export const CLI = path.join(ROOT, "dist", "cli.js");
export const STUB = path.join(ROOT, "test", "fixtures", "skills-stub.mjs");

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export function runCli(
  args: string[],
  opts: { home: string; cwd?: string; input?: string; env?: Record<string, string>; cli?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [opts.cli ?? CLI, ...args], {
      cwd: opts.cwd ?? opts.home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
        METASKILL_HOME: path.join(opts.home, ".metaskill"),
        METASKILL_SKILLS_CMD: `"${process.execPath}" "${STUB}"`,
        STUB_LOG: path.join(opts.home, "stub-calls.log"),
        // Every CLI process this harness spawns must stay off the real
        // network — `sync` would otherwise download the real ~23.8MB index
        // release on every run. See refresh.ts.
        METASKILL_SKIP_INDEX_REFRESH: "1",
        // loadIndex()'s default lookup (no --index) is indexPath() then
        // snapshotPath() — and snapshotPath() sits under the real package
        // root, outside this sandbox, so a developer's locally-built
        // index-snapshot.json would otherwise leak into every spawned CLI's
        // result. Pointing METASKILL_INDEX at the same path indexPath()
        // already computes keeps every test that seeds `.metaskill/index.json`
        // working unchanged, while any test that seeds nothing there
        // deterministically gets no index instead of a developer's real one.
        // Tests that need a specific index still pass --index explicitly,
        // which loadIndex() honors ahead of this variable.
        METASKILL_INDEX: path.join(opts.home, ".metaskill", "index.json"),
        ...opts.env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
    child.stdin.end(opts.input ?? "");
  });
}

export function topRelevanceOf(stdout: string, pkg: string): number {
  const row = stdout.split("\n").find((l) => l.includes(`${pkg} (`))!;
  return Number(/relevance=(\d+\.\d+)/.exec(row)![1]);
}

export function freshHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `metaskill-int-${tag}-`));
}

// A complete, relocatable copy of the package: dist/cli.js under a temp root,
// so packageRoot() — and with it snapshotPath() and installSelfCopy()'s own
// asset copies — resolves inside the sandbox. It is the only way to exercise
// the packaged-snapshot fallback, or `init`'s self-install, without writing
// to the checkout's own index-snapshot.json (an earlier test did, clobbering
// a real artifact mid-run and restoring it in a `finally`) or its real
// ~/.metaskill/bin. templates/skills/commands are real copies from this
// checkout: initCommand reads templates/metaskill.yaml and
// skills/metaskill/SKILL.md unconditionally (no existsSync guard), so a
// root missing them makes any init test fail on an ENOENT, not the
// assertion under test. Returns the path of the CLI to spawn.
export function tempPackage(tag: string, snapshot?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `metaskill-pkg-${tag}-`));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, "dist", "cli.js"));
  for (const dir of ["templates", "skills", "commands"]) {
    fs.cpSync(path.join(ROOT, dir), path.join(root, dir), { recursive: true });
  }
  if (snapshot !== undefined) {
    fs.writeFileSync(path.join(root, "index-snapshot.json"), JSON.stringify(snapshot));
  }
  return path.join(root, "dist", "cli.js");
}

// One index record, with the fields find/policy actually read.
export function rec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "skill", source: "o/r", pkg: "o/r@skill", description: "A skill.",
    installs: 10, installsPrior: null, estimated: false, atRepoRoot: false,
    scan: "clean", scanFindings: [], scanAdvisories: [], ...over,
  };
}

export function indexFile(skills: unknown[], schemaVersion = 1): unknown {
  return { schemaVersion, builtAt: new Date().toISOString(), skillCount: skills.length, repoCount: 1, skills };
}

export function stubCalls(home: string): string[][] {
  try {
    return fs
      .readFileSync(path.join(home, "stub-calls.log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  } catch {
    return [];
  }
}

export function readLockFile(home: string): Record<string, { skill: string; version?: string; domain?: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "skills-lock.json"), "utf8"));
  } catch {
    return {};
  }
}

export function readStateFile(home: string): { lastSyncTs?: string; pendingNotices?: string[] } {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "state.json"), "utf8"));
  } catch {
    return {};
  }
}

// Writes a synthetic index.json for `find --index`. Deliberately untyped
// (`any`): some tests hand it index records that don't conform to
// IndexRecord on purpose, to reproduce a corrupted/hand-edited index.json.
export function writeIndex(home: string, skills: any[], filename = "index.json"): string {
  const file = path.join(home, filename);
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), skillCount: skills.length, repoCount: 1, skills }),
  );
  return file;
}

// The rows of ~/.metaskill/log.jsonl in a sandbox home, parsed.
export function logRows(home: string): any[] {
  try {
    return fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
