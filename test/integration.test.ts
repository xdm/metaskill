import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const STUB = path.join(ROOT, "test", "fixtures", "skills-stub.mjs");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCli(
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
        // Every CLI process this suite spawns must stay off the real
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

function freshHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `metaskill-int-${tag}-`));
}

// A complete, relocatable copy of the package: dist/cli.js under a temp root,
// so packageRoot() — and with it snapshotPath() — resolves inside the
// sandbox. It is the only way to exercise the packaged-snapshot fallback
// without writing to the checkout's own index-snapshot.json, which an earlier
// test did (clobbering a real artifact mid-run and restoring it in a
// `finally`). Returns the path of the CLI to spawn.
function tempPackage(tag: string, snapshot?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `metaskill-pkg-${tag}-`));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(CLI, path.join(root, "dist", "cli.js"));
  if (snapshot !== undefined) {
    fs.writeFileSync(path.join(root, "index-snapshot.json"), JSON.stringify(snapshot));
  }
  return path.join(root, "dist", "cli.js");
}

// One index record, with the fields find/policy actually read.
function rec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "skill", source: "o/r", pkg: "o/r@skill", description: "A skill.",
    installs: 10, installsPrior: null, estimated: false, atRepoRoot: false,
    scan: "clean", scanFindings: [], scanAdvisories: [], ...over,
  };
}

function indexFile(skills: unknown[], schemaVersion = 1): unknown {
  return { schemaVersion, builtAt: new Date().toISOString(), skillCount: skills.length, repoCount: 1, skills };
}

function stubCalls(home: string): string[][] {
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

function readLockFile(home: string): Record<string, { skill: string; version?: string; domain?: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "skills-lock.json"), "utf8"));
  } catch {
    return {};
  }
}

function readStateFile(home: string): { lastSyncTs?: string; pendingNotices?: string[] } {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "state.json"), "utf8"));
  } catch {
    return {};
  }
}

// Writes a synthetic index.json for `find --index`. Deliberately untyped
// (`any`): some tests hand it index records that don't conform to
// IndexRecord on purpose, to reproduce a corrupted/hand-edited index.json.
function writeIndex(home: string, skills: any[], filename = "index.json"): string {
  const file = path.join(home, filename);
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), skillCount: skills.length, repoCount: 1, skills }),
  );
  return file;
}

describe("route end-to-end (stubbed skills CLI)", () => {
  it("emits nothing and logs the prompt, whatever language it is in", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ms-route-"));
    const r = await runCli(["route"], {
      home,
      input: JSON.stringify({ session_id: "s", cwd: home, user_prompt: "напиши тесты для роутера" }),
    });
    expect(r.stdout.trim()).toBe("");
    const log = fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0].domains).toEqual([]);
    expect(log[0].prompt_hash).toMatch(/^sha256:/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("still ignores system traffic", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ms-route-sys-"));
    await runCli(["route"], {
      home,
      input: JSON.stringify({ session_id: "s", cwd: home, user_prompt: "<system-reminder>pdf</system-reminder>" }),
    });
    expect(fs.existsSync(path.join(home, ".metaskill", "log.jsonl"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("garbage stdin never breaks the hook", async () => {
    const home = freshHome("garbage");
    const r = await runCli(["route"], { home, input: "this is not json{{{" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("find end-to-end (stubbed skills CLI, custom --index)", () => {
  it("threads --index through the real CLI (regression guard for the parseArgs prerequisite)", async () => {
    const home = freshHome("find-flag");
    const idx = writeIndex(home, [
      {
        name: "widgetzzz", source: "acme/tools", pkg: "acme/tools@widgetzzz",
        description: "Manipulate zzz widgets end to end.", installs: 100, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    // If --index were parsed as a boolean (the bug the brief's parseArgs
    // ordering step guards against), the path would leak into the query and
    // opts.index would be undefined, so loadIndex would fall back to the
    // packaged snapshot/default home — neither of which has heard of a
    // test-only package like this one.
    const r = await runCli(["find", "widgetzzz", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("acme/tools@widgetzzz");
    expect(r.stdout).toContain("[ask: publisher acme not allowlisted]");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("distinguishes a registry that answered nothing from one that never answered", async () => {
    // Both end with zero candidates, but only one of them is evidence that no
    // skill exists. Printing `No skills found` for a timeout would have the
    // model deny a skill on the strength of a lookup that never completed.
    const home = freshHome("find-live");
    const idx = writeIndex(home, [
      {
        name: "unrelated", source: "acme/tools", pkg: "acme/tools@unrelated",
        description: "Nothing to do with the query.", installs: 3, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);

    const empty = await runCli(["find", "zzqq nomatch", "--index", idx], { home, env: { STUB_FIND_EMPTY: "1" } });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('No skills found for "zzqq nomatch"');
    expect(empty.stdout).not.toContain("Registry did not answer");

    // Fresh home: the 24h discovery cache would otherwise serve the empty run.
    const home2 = freshHome("find-live-fail");
    const idx2 = writeIndex(home2, [
      {
        name: "unrelated", source: "acme/tools", pkg: "acme/tools@unrelated",
        description: "Nothing to do with the query.", installs: 3, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    const failed = await runCli(["find", "zzqq nomatch", "--index", idx2], { home: home2, env: { STUB_FIND_FAIL: "1" } });
    expect(failed.code).toBe(0); // never breaks the caller
    expect(failed.stdout).toContain('Registry did not answer for "zzqq nomatch"');
    expect(failed.stdout).toContain("this is not a miss");
    expect(failed.stdout).not.toContain("No skills found");

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
  });

  it("too-short query: usage error, exit 2", async () => {
    const home = freshHome("find-short");
    const r = await runCli(["find", "ab"], { home });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: metaskill find "<capability words>"');
    expect(r.stdout).toBe("");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("local hit -> auto decision -> install succeeds, names the installed package", async () => {
    const home = freshHome("find-auto");
    const idx = writeIndex(home, [
      {
        name: "gizmo", source: "anthropics/skills", pkg: "anthropics/skills@gizmo",
        description: "Gizmo automation toolkit for gizmo workflows.", installs: 999999, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    const r = await runCli(["find", "gizmo automation", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Installed now: anthropics/skills@gizmo");
    expect(r.stdout).toContain("Read that SKILL.md and follow it.");
    expect(fs.existsSync(path.join(home, ".claude", "skills", "gizmo", "SKILL.md"))).toBe(true);
    // The lock's `domain` is the query phrase that found it — find.ts's own
    // record of what matched, which `metaskill list` later shows under
    // MATCHED. Nothing downstream reads it back to make a decision.
    expect(readLockFile(home)["anthropics/skills@gizmo"]).toMatchObject({
      skill: "gizmo",
      version: "1.2.3",
      domain: "gizmo automation",
    });
    const listed = await runCli(["list"], { home });
    expect(listed.stdout).toMatch(/SKILL\s+PACKAGE\s+VERSION\s+MATCHED\s+INSTALLED\s+STATUS/);
    expect(listed.stdout).toContain("gizmo automation");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("install failure never claims success — prints the ask-and-retry line", async () => {
    const home = freshHome("find-failinstall");
    const idx = writeIndex(home, [
      {
        name: "thingamajig", source: "anthropics/skills", pkg: "anthropics/skills@thingamajig",
        description: "Thingamajig helper for thingamajig tasks.", installs: 999999, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    const r = await runCli(["find", "thingamajig", "--index", idx], { home, env: { STUB_ADD_FAIL: "1" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `Install failed — ask the user, then run: "${process.execPath}" "${CLI}" install anthropics/skills@thingamajig --force`,
    );
    expect(r.stdout).not.toContain("Installed now:");
    expect(readLockFile(home)["anthropics/skills@thingamajig"]).toBeUndefined();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("nothing qualifies for auto: ranked ask-block with install counts and decisions", async () => {
    const home = freshHome("find-ask");
    const idx = writeIndex(home, [
      {
        name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex",
        description: "Snorklex data processor for snorklex pipelines.", installs: 42, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
      {
        name: "snorklex-lite", source: "otherorg/tools", pkg: "otherorg/tools@snorklex-lite",
        description: "Lightweight snorklex helper.", installs: null, installsPrior: 12,
        estimated: true, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    const r = await runCli(["find", "snorklex", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Top matches for "snorklex"');
    expect(r.stdout).toContain("someorg/repo@snorklex (42 installs");
    expect(r.stdout).toContain("otherorg/tools@snorklex-lite (~12 est installs");
    expect(r.stdout).toContain("[ask:");
    expect(r.stdout).toContain(`On an explicit yes run: "${process.execPath}" "${CLI}" install <pkg> --force`);
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Pins findings A, B and C together: a dirty record with no scanFindings
  // key, a clean record with scanAdvisories explicitly null, and — separate
  // query, separate index — two same-scoring records where one has no pkg
  // at all. loadIndex/readOne only checks that `skills` is an array, never
  // each record's shape, so all four are realistic corruption, not just
  // adversarial input.
  it("a malformed index record never crashes the command", async () => {
    const home = freshHome("find-malformed");

    const idxScan = writeIndex(
      home,
      [
        {
          name: "flumbex-a", source: "foo/bar", pkg: "foo/bar@flumbex-a",
          description: "Flumbex processor for flumbex pipelines.", installs: 50, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "dirty", scanAdvisories: [],
          // scanFindings key omitted on purpose
        },
        {
          name: "flumbex-b", source: "foo/bar", pkg: "foo/bar@flumbex-b",
          description: "Flumbex variant tool for flumbex tasks.", installs: 30, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: null,
        },
      ],
      "index-scan.json",
    );
    const r1 = await runCli(["find", "flumbex", "--index", idxScan], { home });
    expect(r1.code).toBe(0);
    expect(r1.stderr).toBe("");
    expect(r1.stdout).toContain("foo/bar@flumbex-a");
    expect(r1.stdout).toContain("foo/bar@flumbex-b");
    expect(r1.stdout).not.toContain("find error");

    const idxPkg = writeIndex(
      home,
      [
        {
          name: "quibblexyz", source: "zzz/pkg", pkg: "zzz/pkg@quibblexyz",
          description: "Quibblexyz tool for quibblexyz tasks.", installs: 5, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
        },
        {
          name: "quibblexyz", source: "zzz/pkg",
          // pkg omitted on purpose — ties in BM25 score with the record
          // above (identical name/description), which is what forces
          // search()'s tie-break comparator to actually run on it.
          description: "Quibblexyz tool for quibblexyz tasks.", installs: 5, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
        },
      ],
      "index-pkg.json",
    );
    const r2 = await runCli(["find", "quibblexyz", "--index", idxPkg], { home });
    expect(r2.code).toBe(0);
    // The raw-crash path (uncaught exception -> cli.ts's top-level handler)
    // always writes "metaskill: <stack>" and exits 1; neither ever happens
    // here, whether this record made it into a clean top-matches line or
    // was caught by findCommand's own try/catch.
    expect(r2.stderr).not.toMatch(/^metaskill: /m);
    expect(r2.stdout + r2.stderr).toContain("[metaskill]");

    fs.rmSync(home, { recursive: true, force: true });
  });

  // A lone pkg-less record degrading gracefully (above) is not the same bug
  // as this one: `rows = hits.map(...)` throws the instant it reaches ANY
  // poisoned element, discarding the whole array — so before search() filters
  // a pkg-less record out at the source, one corrupted record anywhere in the
  // top-5 hides every well-formed candidate ranked beside it, not just itself.
  it("a corrupted record inside a mixed batch never hides the well-formed candidates beside it", async () => {
    const home = freshHome("find-mixed");
    const idxMixed = writeIndex(
      home,
      [
        {
          name: "sprocketamatic", source: "anthropics/skills", pkg: "anthropics/skills@sprocketamatic",
          description: "Sprocketamatic build tool for sprocketamatic pipelines.", installs: 500000,
          installsPrior: null, estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [],
          scanAdvisories: [],
        },
        {
          name: "sprocketamatic-ghost", source: "zzz/broken",
          // pkg omitted on purpose — a corrupted record co-ranked with the
          // well-formed one above, both inside the default top-5.
          description: "Sprocketamatic ghost entry with no pkg.", installs: 10, installsPrior: null,
          estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
        },
      ],
      "index-mixed.json",
    );
    const r3 = await runCli(["find", "sprocketamatic", "--index", idxMixed], { home });
    expect(r3.code).toBe(0);
    // The failure mode this pins: pre-fix, the whole response collapsed to
    // the generic "[metaskill] find error: ..." line on stderr, and stdout
    // was empty — hiding the allowlisted, auto-installable candidate.
    expect(r3.stdout).toContain("anthropics/skills@sprocketamatic");
    expect(r3.stdout).not.toContain("sprocketamatic-ghost");
    expect(readLockFile(home)["anthropics/skills@sprocketamatic"]).toBeTruthy();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("find: only the top-ranked hit installs, and only above the relevance floor", () => {
  // Before this, `find` took the first row whose DECISION was `auto`,
  // wherever it ranked, and acted on any BM25 hit at all. Measured against
  // the shipped snapshot: 29 of 30 junk phrases ("say hello", "weather in
  // paris") auto-installed a third-party skill unattended, and on 25 real
  // capability phrases 11 installed something that was not the top match.

  it("a junk query whose best hit is weak installs nothing and does not even search live", async () => {
    const home = freshHome("find-floor");
    const idx = writeIndex(home, [
      // Allowlisted + clean, so policy would say `auto` the moment anything
      // reached it. Only "hello" of the query is in this description, so the
      // hit is a fragment of a match, not a match.
      rec({ name: "cardputer-buddy", source: "anthropics/plugins", pkg: "anthropics/plugins@cardputer-buddy",
            description: "Say hello to your handheld device companion.", installs: 900 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
    const r = await runCli(["find", "say hello zorbulon", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No skills found for "say hello zorbulon"');
    expect(r.stdout).not.toContain("Installed now:");
    expect(r.stdout).not.toContain("Top matches");
    // A weak local hit is not a reason to go to the network either: the live
    // fallback exists for a query the index has never heard of.
    expect(stubCalls(home)).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("a second-ranked auto row never installs when the top-ranked row is ask", async () => {
    const home = freshHome("find-rank");
    const idx = writeIndex(home, [
      // Ranks first (it repeats both query terms), but 42 installs from an
      // unknown publisher -> ask.
      rec({ name: "zorptastic-pro", source: "someorg/repo", pkg: "someorg/repo@zorptastic-pro",
            description: "Zorptastic widget tooling: zorptastic widget pipelines, zorptastic widget builds.",
            installs: 42 }),
      // Ranks second, and is exactly the row the old code installed.
      rec({ name: "zorptastic", source: "anthropics/skills", pkg: "anthropics/skills@zorptastic",
            description: "Zorptastic widget helper for teams of every size and shape.", installs: 999999 }),
    ]);
    const r = await runCli(["find", "zorptastic widget", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Installed now:");
    expect(r.stdout).toContain('Top matches for "zorptastic widget"');
    // Both rows are still offered — the model asks the user, which is the
    // deliberate step the spec calls for (§4.4).
    expect(r.stdout).toContain("someorg/repo@zorptastic-pro");
    expect(r.stdout).toContain("anthropics/skills@zorptastic");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("the top-ranked row still installs when it is the one policy trusts", async () => {
    const home = freshHome("find-rank-ok");
    const idx = writeIndex(home, [
      rec({ name: "zorptastic", source: "anthropics/skills", pkg: "anthropics/skills@zorptastic",
            description: "Zorptastic widget helper: zorptastic widget pipelines and zorptastic widget builds.",
            installs: 999999 }),
      rec({ name: "zorptastic-lite", source: "someorg/repo", pkg: "someorg/repo@zorptastic-lite",
            description: "A lighter zorptastic widget helper.", installs: 42 }),
    ]);
    const r = await runCli(["find", "zorptastic widget", "--index", idx], { home });
    expect(r.stdout).toContain("Installed now: anthropics/skills@zorptastic");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("gives the unattended install the same 120s the manual path gets, not the 20s default", async () => {
    // Measured at 20.17s ending in a timeout on exactly this path — the one
    // nobody is watching. installSkill's own default (or the env override
    // standing in for it here) must not be what governs it: with the caller
    // passing 120s, a deliberately tiny METASKILL_INSTALL_TIMEOUT_MS cannot
    // reach the call, and an install that takes longer than it still lands.
    const home = freshHome("find-timeout");
    const idx = writeIndex(home, [
      rec({ name: "slowpoke", source: "anthropics/skills", pkg: "anthropics/skills@slowpoke",
            description: "Slowpoke automation toolkit for slowpoke automation workflows.", installs: 999999 }),
    ]);
    const r = await runCli(["find", "slowpoke automation", "--index", idx], {
      home,
      env: { METASKILL_INSTALL_TIMEOUT_MS: "1", STUB_ADD_SLEEP_MS: "250" },
    });
    expect(r.stdout).toContain("Installed now: anthropics/skills@slowpoke");
    expect(r.stdout).not.toContain("timed out");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("never lists a denied package under the ask header or beside an install command", async () => {
    // `deny` rows printed under "ask the user ONE question before installing
    // any", above a line reading `install <pkg> --force`, invite the model to
    // go get approval for something no flag can install.
    const home = freshHome("find-deny");
    const idx = writeIndex(home, [
      rec({ name: "flumbex", source: "anthropics/skills", pkg: "anthropics/skills@flumbex",
            description: "Flumbex widget processor for flumbex widget pipelines.", installs: 999999,
            scan: "dirty", scanFindings: ["os.environ in script.py"] }),
      rec({ name: "flumbex-lite", source: "someorg/repo", pkg: "someorg/repo@flumbex-lite",
            description: "Lightweight flumbex widget helper.", installs: 42 }),
    ]);
    const r = await runCli(["find", "flumbex widget", "--index", idx], { home });
    expect(r.code).toBe(0);
    const askHeader = r.stdout.indexOf("ask the user ONE question");
    const forceLine = r.stdout.indexOf("install <pkg> --force");
    const denied = r.stdout.indexOf("anthropics/skills@flumbex ");
    expect(askHeader).toBeGreaterThanOrEqual(0);
    expect(denied).toBeGreaterThan(forceLine); // below the ask block, never inside it
    expect(r.stdout).toContain("Refused by policy");
    expect(r.stdout).toContain("someorg/repo@flumbex-lite");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints the documented No-skills-found line when every match is denied", async () => {
    const home = freshHome("find-alldeny");
    const idx = writeIndex(home, [
      rec({ name: "flumbex", source: "anthropics/skills", pkg: "anthropics/skills@flumbex",
            description: "Flumbex widget processor for flumbex widget pipelines.", installs: 999999,
            scan: "dirty", scanFindings: ["os.environ in script.py"] }),
    ]);
    const r = await runCli(["find", "flumbex widget", "--index", idx], { home });
    expect(r.stdout).toContain('No skills found for "flumbex widget"');
    expect(r.stdout).not.toContain("ask the user ONE question");
    expect(r.stdout).not.toContain("install <pkg> --force");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("find: reinstall protection matches a name, never a word inside one", () => {
  function installSkillOnDisk(home: string, name: string): void {
    const dir = path.join(home, ".claude", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n`);
  }

  it("does not answer an unrelated query with an installed skill that shares a word", async () => {
    // With only `codebase-memory` installed, both `find "code review"` and
    // `find "memory profiling"` answered "Already present: codebase-memory",
    // suppressed the index lookup entirely, and sent the model off to read an
    // unrelated SKILL.md. The rate grew with every skill installed.
    const home = freshHome("find-present-fp");
    installSkillOnDisk(home, "codebase-memory");
    const idx = writeIndex(home, [
      rec({ name: "reviewer", source: "someorg/repo", pkg: "someorg/repo@reviewer",
            description: "Code review assistant: code review checklists and code review reports.",
            installs: 42 }),
    ]);
    const r = await runCli(["find", "code review", "--index", idx], { home });
    expect(r.stdout).not.toContain("Already present");
    expect(r.stdout).toContain("someorg/repo@reviewer"); // it reached the index
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("still short-circuits when the query IS the skill's name", async () => {
    const home = freshHome("find-present-name");
    installSkillOnDisk(home, "codebase-memory");
    const idx = writeIndex(home, [rec({})]);
    const r = await runCli(["find", "codebase memory", "--index", idx], { home });
    expect(r.stdout).toContain("Already present: codebase-memory");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("short-circuits a repeat of the exact phrase that installed a skill, via the lock", async () => {
    const home = freshHome("find-present-lock");
    const idx = writeIndex(home, [
      rec({ name: "sheetwrangler", source: "anthropics/skills", pkg: "anthropics/skills@sheetwrangler",
            description: "Excel spreadsheets toolkit: excel spreadsheets formulas and excel spreadsheets charts.",
            installs: 999999 }),
    ]);
    const first = await runCli(["find", "excel spreadsheets", "--index", idx], { home });
    expect(first.stdout).toContain("Installed now: anthropics/skills@sheetwrangler");
    expect(readLockFile(home)["anthropics/skills@sheetwrangler"]).toMatchObject({ domain: "excel spreadsheets" });

    // The skill is named nothing like the query, so only the lock can answer
    // this — and it must, rather than installing the same package twice.
    const again = await runCli(["find", "excel spreadsheets", "--index", idx], { home });
    expect(again.stdout).toContain("Already present: sheetwrangler");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toHaveLength(1);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("the packaged snapshot is the offline floor", () => {
  // Deleting `?? readOne(snapshotPath())` from loadIndex left the whole suite
  // green: nothing exercised the fallback, because snapshotPath() resolves
  // under the running package's own root. These run a copy of the CLI from a
  // temp package root instead, so the fallback is reachable without touching
  // the checkout's own index-snapshot.json.

  it("answers a lookup from the packaged snapshot with no index.json anywhere", async () => {
    const home = freshHome("snap-fallback");
    const cli = tempPackage(
      "fallback",
      indexFile([
        rec({ name: "snapshotonly", source: "someorg/repo", pkg: "someorg/repo@snapshotonly",
              description: "Snapshotonly widget tool for snapshotonly widget pipelines.", installs: 42 }),
      ]),
    );
    const r = await runCli(["find", "snapshotonly widget"], {
      home,
      cli,
      // No --index, no METASKILL_INDEX override, and ~/.metaskill is empty:
      // the packaged snapshot is the only index that exists.
      env: { METASKILL_INDEX: "" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("someorg/repo@snapshotonly");
    expect(fs.existsSync(path.join(home, ".metaskill", "index.json"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prefers ~/.metaskill/index.json over the snapshot once sync has landed one", async () => {
    const home = freshHome("snap-order");
    const cli = tempPackage(
      "order",
      indexFile([
        rec({ name: "stale", source: "someorg/repo", pkg: "someorg/repo@stale",
              description: "Snapshotonly widget tool for snapshotonly widget pipelines.", installs: 42 }),
      ]),
    );
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "index.json"),
      JSON.stringify(
        indexFile([
          rec({ name: "fresh", source: "someorg/repo", pkg: "someorg/repo@fresh",
                description: "Snapshotonly widget tool for snapshotonly widget pipelines.", installs: 42 }),
        ]),
      ),
    );
    const r = await runCli(["find", "snapshotonly widget"], { home, cli, env: { METASKILL_INDEX: "" } });
    expect(r.stdout).toContain("someorg/repo@fresh");
    expect(r.stdout).not.toContain("someorg/repo@stale");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("a missing METASKILL_INDEX path returns null even with a real snapshot at the package root", async () => {
    // The override is the ONLY file consulted when it is set — otherwise a
    // spawned CLI in a sandboxed HOME silently reads whatever snapshot sits
    // in the package root, and every test that seeds no index gets a
    // developer's real one.
    const home = freshHome("snap-override");
    const cli = tempPackage(
      "override",
      indexFile([
        rec({ name: "snapshotonly", source: "someorg/repo", pkg: "someorg/repo@snapshotonly",
              description: "Snapshotonly widget tool for snapshotonly widget pipelines.", installs: 42 }),
      ]),
    );
    const r = await runCli(["find", "snapshotonly widget"], {
      home,
      cli,
      env: { METASKILL_INDEX: path.join(home, "does-not-exist.json"), STUB_FIND_EMPTY: "1" },
    });
    expect(r.stdout).not.toContain("someorg/repo@snapshotonly");
    expect(r.stdout).toContain("No skills found");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("init end-to-end (spec 4.1)", () => {
  it("registers hooks preserving existing ones, idempotently; uninstall reverses it", async () => {
    const home = freshHome("init");
    const settingsFile = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const original = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool inject" }] }],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));

    const r = await runCli(["init"], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hooks registered");
    expect(r.stdout).toContain("skills CLI: ok");

    const s1 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(s1.model).toBe("opus");
    expect(s1.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    const upsCmds = s1.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(upsCmds).toContain("other-tool inject");
    // hooks must point at the self-installed engine copy, not the running
    // (npx-cache/global) instance — that's what makes `npx ... init` permanent
    const routeCmd = upsCmds.find((c: string) => c.endsWith(" route"))!;
    expect(routeCmd).toContain(path.join(".metaskill", "bin", "dist", "cli.js"));
    expect(fs.existsSync(path.join(home, ".metaskill", "bin", "dist", "cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".metaskill", "bin", "skills", "metaskill", "SKILL.md"))).toBe(true);
    expect(s1.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
    expect(s1.hooks.SessionStart[0].hooks[0].timeout).toBe(120);
    expect(fs.existsSync(path.join(home, ".metaskill", "metaskill.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "metaskill", "SKILL.md"))).toBe(true);

    // /metaskill:* slash commands installed with the placeholder resolved
    const listCmd = fs.readFileSync(path.join(home, ".claude", "commands", "metaskill", "list.md"), "utf8");
    expect(listCmd).toContain("cli.js\" list");
    expect(listCmd).not.toContain("{{METASKILL}}");
    expect(r.stdout).toContain("/metaskill:list");

    // user-edited policy survives re-init; hooks do not duplicate
    fs.appendFileSync(path.join(home, ".metaskill", "metaskill.yaml"), "\n# user edit\n");
    await runCli(["init"], { home });
    const s2 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    expect(s2.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks)).toHaveLength(2); // ours + foreign
    expect(s2.hooks.SessionStart.flatMap((g: any) => g.hooks)).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, ".metaskill", "metaskill.yaml"), "utf8")).toContain("# user edit");

    const u = await runCli(["init", "--uninstall"], { home });
    expect(u.code).toBe(0);
    const s3 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const cmds3 = (s3.hooks.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds3).toEqual(["other-tool inject"]);
    expect(s3.hooks.SessionStart).toBeUndefined();
    expect(s3.hooks.PreToolUse).toEqual(original.hooks.PreToolUse);
    expect(fs.existsSync(path.join(home, ".claude", "skills", "metaskill"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", "commands", "metaskill"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".metaskill", "bin"))).toBe(false); // engine copy removed
    expect(fs.existsSync(path.join(home, ".metaskill", "metaskill.yaml"))).toBe(true); // policy kept
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses to touch an unparseable settings.json", async () => {
    const home = freshHome("badsettings");
    const settingsFile = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, "{broken json");
    const r = await runCli(["init"], { home });
    expect(r.code).toBe(1);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe("{broken json");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("sync end-to-end (spec 4.3)", () => {
  function seedInstalled(home: string, skill: string, version: string) {
    const dir = path.join(home, ".agents", "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\nversion: ${version}\n---\n`);
  }

  it("updates allowlisted skills only, notices the rest, gates on 24h", async () => {
    const home = freshHome("sync");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "skills-lock.json"),
      JSON.stringify({
        "anthropics/skills@xlsx": { pkg: "anthropics/skills@xlsx", skill: "xlsx", installedAt: "2026-08-01T00:00:00Z", version: "1.2.3" },
        "foo/bar@baz": { pkg: "foo/bar@baz", skill: "baz", installedAt: "2026-08-01T00:00:00Z", version: "0.1.0" },
      }),
    );
    seedInstalled(home, "xlsx", "1.2.3");
    seedInstalled(home, "baz", "0.1.0");

    const r = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r.code).toBe(0);
    // Exactly one JSON line per run: a second line on stdout is not a
    // documented hook contract.
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const out = JSON.parse(r.stdout) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("[metaskill] Standing protocol");

    // The update happened AFTER the emit, so its notice is parked in
    // state.json rather than emitted — it rides out on the next session.
    expect(out.hookSpecificOutput.additionalContext).not.toContain("Updated skills: xlsx");
    expect(readStateFile(home).pendingNotices).toEqual([
      "[metaskill] Updated skills: xlsx.",
      expect.stringContaining("baz"),
    ]);

    // METASKILL_SKIP_INDEX_REFRESH (set for every runCli process, see above)
    // must have kept this run off the network: no "index refreshed" notice,
    // and no index.json ever landed in the sandboxed home. A real download
    // succeeding here would write that file (see index-refresh.test.ts and
    // task-5-report.md's real-download measurements) — its absence is
    // direct, black-box proof that refreshIndex's skip path was taken.
    expect(readStateFile(home).pendingNotices!.join("\n")).not.toContain("index refreshed");
    expect(fs.existsSync(path.join(home, ".metaskill", "index.json"))).toBe(false);

    // stub was asked to update ONLY the allowlisted skill
    const updates = stubCalls(home).filter((c) => c[0] === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("xlsx");
    expect(updates[0]).not.toContain("baz");

    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("9.9.9");
    expect(readLockFile(home)["foo/bar@baz"]!.version).toBe("0.1.0");

    // Second run within 24h: the 24h gate closes before any work — but the
    // protocol still goes out, and it carries the parked notices with it.
    const r2 = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r2.stdout.trim().split("\n")).toHaveLength(1);
    const ctx2 = (JSON.parse(r2.stdout) as any).hookSpecificOutput.additionalContext as string;
    expect(ctx2).toContain("[metaskill] Standing protocol");
    expect(ctx2).toContain("Updated skills: xlsx");
    expect(ctx2).toContain("baz");
    expect(stubCalls(home).filter((c) => c[0] === "update")).toHaveLength(1);

    // Third run: notices surfaced once and were cleared — they must not
    // repeat on every session thereafter.
    const r3 = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    const ctx3 = (JSON.parse(r3.stdout) as any).hookSpecificOutput.additionalContext as string;
    expect(ctx3).toContain("[metaskill] Standing protocol");
    expect(ctx3).not.toContain("Updated skills");
    expect(readStateFile(home).pendingNotices).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("emits the protocol on a fresh home with nothing installed", async () => {
    // The two early returns (24h gate above, empty lock here) both sit AFTER
    // the emit. v1's central defect was sessions that received no metaskill
    // context at all; no exit path may reproduce it.
    const home = freshHome("sync-fresh");
    const r = await runCli(["sync"], { home });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const ctx = (JSON.parse(r.stdout) as any).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("[metaskill] Standing protocol");
    // Through the real spawned CLI, so cliEntryPath() resolves to dist/cli.js
    // rather than the source tree, and both halves are absolute and quoted.
    expect(ctx).toContain(`"${process.execPath}" "${CLI}" find "`);
    expect(stubCalls(home)).toHaveLength(0);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("update/sync: a dirty scan blocks even an allowlisted package (spec §7 Defect 1)", () => {
  function seedInstalled(home: string, skill: string, version: string) {
    const dir = path.join(home, ".agents", "skills", skill);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\nversion: ${version}\n---\n`);
  }

  // Seeds a locked, installed anthropics/skills@xlsx plus the local
  // index.json that loadIndex() reads with no explicit path — exactly how
  // update.ts and sync.ts call it — carrying the given verdict for it.
  function seed(home: string, scan: "clean" | "dirty") {
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "skills-lock.json"),
      JSON.stringify({
        "anthropics/skills@xlsx": {
          pkg: "anthropics/skills@xlsx", skill: "xlsx", installedAt: "2026-08-01T00:00:00Z", version: "1.2.3",
        },
      }),
    );
    seedInstalled(home, "xlsx", "1.2.3");
    fs.writeFileSync(
      path.join(home, ".metaskill", "index.json"),
      JSON.stringify({
        schemaVersion: 1, builtAt: "2026-08-31T00:00:00.000Z", skillCount: 1, repoCount: 1,
        skills: [
          {
            name: "xlsx", source: "anthropics/skills", pkg: "anthropics/skills@xlsx",
            description: "d", installs: 999999, installsPrior: null, estimated: false, atRepoRoot: false,
            scan, scanFindings: scan === "dirty" ? ["eval("] : [], scanAdvisories: [],
          },
        ],
      }),
    );
  }

  it("`metaskill update` skips a dirty-scanned allowlisted package", async () => {
    const home = freshHome("update-dirty");
    seed(home, "dirty");
    const r = await runCli(["update"], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("skip xlsx: index scan is dirty");
    expect(r.stderr).toContain("no flag bypasses a dirty scan");
    expect(stubCalls(home).filter((c) => c[0] === "update")).toEqual([]);
    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("1.2.3");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("`metaskill update --force` does not bypass a dirty scan — deny-tier, not ask-tier", async () => {
    const home = freshHome("update-dirty-force");
    seed(home, "dirty");
    const r = await runCli(["update", "--force"], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("skip xlsx: index scan is dirty");
    expect(stubCalls(home).filter((c) => c[0] === "update")).toEqual([]);
    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("1.2.3");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("`metaskill update` proceeds once the verdict is clean", async () => {
    const home = freshHome("update-clean");
    seed(home, "clean");
    const r = await runCli(["update"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r.code).toBe(0);
    expect(stubCalls(home).filter((c) => c[0] === "update")).toHaveLength(1);
    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("9.9.9");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("sync's unattended auto-update skips the same dirty package instead of updating it on a timer", async () => {
    const home = freshHome("sync-dirty");
    seed(home, "dirty");
    const r = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r.code).toBe(0);
    expect(stubCalls(home).filter((c) => c[0] === "update")).toEqual([]);
    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("1.2.3");
    // Must not vanish silently: parked in pendingNotices like every other
    // sync notice, to surface on the next session's emit.
    const notices = readStateFile(home).pendingNotices!.join("\n");
    expect(notices).toContain("Skipped xlsx");
    expect(notices).toContain("index scan is dirty");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("sync updates the same package normally once the verdict is clean", async () => {
    const home = freshHome("sync-clean");
    seed(home, "clean");
    const r = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r.code).toBe(0);
    expect(stubCalls(home).filter((c) => c[0] === "update")).toHaveLength(1);
    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("9.9.9");
    expect(readStateFile(home).pendingNotices!.join("\n")).toContain("Updated skills: xlsx");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("manual install: deny is final (spec §5)", () => {
  it("--force bypasses ask but never deny", async () => {
    const home = freshHome("deny");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "metaskill.yaml"),
      "trust:\n  deny_publishers: [evil]\n",
    );
    const r = await runCli(["install", "evil/repo@thing", "--force"], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DENIED");
    expect(r.stderr).toContain("cannot be bypassed");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("manual install reads the index verdict, for every publisher (spec §7 Defect 2)", () => {
  function seedIndex(home: string, skills: unknown[]): void {
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(path.join(home, ".metaskill", "index.json"), JSON.stringify(indexFile(skills)));
  }

  it("refuses an allowlisted package the index scans dirty, and --force does not help", async () => {
    // This path ran NO scan at all for an allowlisted publisher and handed
    // decide() a bare "skipped", so `metaskill install anthropics/skills@xlsx`
    // installed — silently — a package the index shipped in this very package
    // marks dirty.
    const home = freshHome("install-dirty");
    seedIndex(home, [
      rec({ name: "xlsx", source: "anthropics/skills", pkg: "anthropics/skills@xlsx",
            description: "Excel workbooks.", installs: 158400,
            scan: "dirty", scanFindings: ["os.environ in scripts/x.py"] }),
    ]);
    const r = await runCli(["install", "anthropics/skills@xlsx"], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DENIED");
    expect(r.stderr).toContain("os.environ");
    expect(r.stdout).not.toContain("Scanning"); // the verdict came from the index, not a download
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);

    const forced = await runCli(["install", "anthropics/skills@xlsx", "--force"], { home });
    expect(forced.code).toBe(1);
    expect(forced.stderr).toContain("cannot be bypassed");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("installs an allowlisted package the index scans clean, without downloading anything", async () => {
    const home = freshHome("install-clean");
    seedIndex(home, [
      rec({ name: "xlsx", source: "anthropics/skills", pkg: "anthropics/skills@xlsx",
            description: "Excel workbooks.", installs: 158400 }),
    ]);
    const r = await runCli(["install", "anthropics/skills@xlsx"], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Installed anthropics/skills@xlsx");
    expect(r.stdout).not.toContain("Scanning");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("falls back to the live scan only when the package is absent from the index — allowlist included", async () => {
    // A non-GitHub package: scanCandidate returns "unavailable" before it
    // touches the network, which is exactly the "no verdict" case the
    // allowlist used to auto-install straight through.
    const home = freshHome("install-fallback");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(path.join(home, ".metaskill", "metaskill.yaml"), "trust:\n  allowlist: [modelscope.cn]\n");
    seedIndex(home, [rec({})]); // an index that has never heard of the package below

    const r = await runCli(["install", "modelscope.cn@node-helper"], { home });
    expect(r.stdout).toContain("Scanning modelscope.cn@node-helper");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Needs confirmation");
    expect(r.stderr).toContain("unavailable");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("list command", () => {
  it("shows what metaskill installed, with on-disk status and alias", async () => {
    const home = freshHome("list");
    const empty = await runCli(["list"], { home });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("hasn't installed anything yet");

    // route no longer installs anything itself (it only logs); seed the same
    // on-disk state `install` would have produced as a side effect before.
    // Manual install has no --domain flag any more — no query phrase to
    // record — so this entry's MATCHED column renders "-".
    //
    // The index carries the verdict `install` now decides on (spec §7 Defect
    // 2), so it has to exist: without it the command falls back to the live
    // tarball scan, which this suite must never reach.
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "index.json"),
      JSON.stringify(indexFile([rec({ name: "xlsx", source: "anthropics/skills", pkg: "anthropics/skills@xlsx",
                                      description: "Excel workbooks.", installs: 158400 })])),
    );
    await runCli(["install", "anthropics/skills@xlsx"], { home });
    const r = await runCli(["list"], { home });
    expect(r.stdout).toMatch(/SKILL\s+PACKAGE\s+VERSION\s+MATCHED\s+INSTALLED\s+STATUS/);
    expect(r.stdout).toContain("anthropics/skills@xlsx");
    expect(r.stdout).toContain("v1.2.3");
    expect(r.stdout).toMatch(/^xlsx\s+.*\bok$/m);

    const ls = await runCli(["ls"], { home });
    expect(ls.stdout).toContain("anthropics/skills@xlsx");

    // removing the files flips the status so stale locks are visible
    fs.rmSync(path.join(home, ".agents", "skills", "xlsx"), { recursive: true, force: true });
    fs.rmSync(path.join(home, ".claude", "skills", "xlsx"), { recursive: true, force: true });
    const gone = await runCli(["list"], { home });
    expect(gone.stdout).toContain("MISSING");
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Backward compat: a lock written by an older metaskill version carries
  // `domain` as a taxonomy id (e.g. "xlsx"), not a query phrase. list must
  // not crash on it, and must show it under the renamed MATCHED column —
  // both are equally "what matched" from the reader's point of view.
  it("renders an old lock entry's domain value under MATCHED", async () => {
    const home = freshHome("list-oldlock");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "skills-lock.json"),
      JSON.stringify({
        "anthropics/skills@xlsx": {
          pkg: "anthropics/skills@xlsx",
          skill: "xlsx",
          installedAt: "2026-08-01T00:00:00Z",
          version: "1.2.3",
          domain: "xlsx",
        },
      }),
    );
    const r = await runCli(["list"], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/SKILL\s+PACKAGE\s+VERSION\s+MATCHED\s+INSTALLED\s+STATUS/);
    expect(r.stdout).toMatch(/^xlsx\s+anthropics\/skills@xlsx\s+v1\.2\.3\s+xlsx\s+/m);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("packaged assets", () => {
  it("plugin manifest, hooks and marketplace entry stay consistent with the package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin.name).toBe("metaskill");
    expect(plugin.version).toBe(pkg.version); // plugin version pins updates; keep it in step

    const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
    const cmds = Object.values(hooks.hooks).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(cmds).toHaveLength(2);
    // plugin hooks must be relocatable: no absolute paths, only the plugin root
    for (const c of cmds) expect(c).toContain("${CLAUDE_PLUGIN_ROOT}/dist/cli.js");
    expect(cmds.some((c: string) => c.endsWith(" route"))).toBe(true);
    expect(cmds.some((c: string) => c.endsWith(" sync"))).toBe(true);

    // The plugin channel's SessionStart matcher, which nothing pinned before:
    // settings.ts (the standalone `init` channel) is asserted in three places
    // and this file in none, so `compact` could have been dropped here with a
    // green suite. Every source that can start a session without the protocol
    // must be listed — `compact` above all, since auto-compact fires on its
    // own and is the ordinary way a long session loses injected context.
    const sessionStart = hooks.hooks.SessionStart as Array<{ matcher?: string; hooks: unknown[] }>;
    expect(sessionStart).toHaveLength(1);
    for (const source of ["startup", "resume", "clear", "compact"]) {
      expect(sessionStart[0]!.matcher, source).toContain(source);
    }

    const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(market.plugins[0].source).toEqual({ source: "npm", package: pkg.name });

    // slash commands must resolve the CLI without init-time templating
    for (const f of fs.readdirSync(path.join(ROOT, "commands"))) {
      const body = fs.readFileSync(path.join(ROOT, "commands", f), "utf8");
      expect(body, f).toContain("CLAUDE_PLUGIN_ROOT");
      expect(body, f).not.toContain("{{");
    }

    // everything the plugin needs must ship in the npm tarball — dist/cli.js
    // specifically, not the whole dist/ directory: the CI-only index builder
    // is unreachable via "bin" and has no reason to ride along with it.
    // index-snapshot.json is the offline floor: dropped from `files`, a fresh
    // install has no index at all until `sync` has run and downloaded one.
    for (const entry of [
      "dist/cli.js", "index-snapshot.json", "skills", "commands", "hooks", "templates", ".claude-plugin",
    ]) {
      expect(pkg.files, entry).toContain(entry);
    }
  });

  it("SKILL.md stays within the 1500-token budget (spec 4.8)", () => {
    const md = fs.readFileSync(path.join(ROOT, "skills", "metaskill", "SKILL.md"), "utf8");
    // ~4 chars/token upper bound: 6000 chars ≈ 1500 tokens
    expect(md.length).toBeLessThanOrEqual(6000);
    // It must still tell the model how to install — but never with the bare
    // `metaskill install` spelling, which is absent from the PATH a hook or a
    // Bash call inherits. SKILL.md is copied verbatim (no {{METASKILL}}
    // substitution, unlike commands/*.md), so it points at the command the
    // block prints rather than interpolating a path it cannot know.
    expect(md).toContain("install <pkg> --force");
    expect(md).toContain("dist/cli.js");
    expect(md).not.toMatch(/`metaskill (install|update|log|init)\b/);
    expect(md).toContain("one");
  });
});
