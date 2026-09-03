import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadIndex, normaliseQuery, search } from "../src/index/read.js";

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
function tempPackage(tag: string, snapshot?: unknown): string {
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
    expect(r.stdout).toContain("[ask: needs your yes — publisher acme not allowlisted]");
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

  it("find never installs, even for a trusted clean top hit", async () => {
    // The defect this replaces: the top-ranked BM25 hit installed itself,
    // globally, with nobody asked — on junk queries too, because BM25 reports
    // how much of a query a row matched and cannot judge whether the row
    // answers the task. Code ranks, the model picks, `install` enforces
    // policy (spec §4.4). This row is the most trusted case there is —
    // allowlisted publisher, clean scan, 999999 installs — and it still only
    // gets printed.
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
    expect(r.stdout).toContain('Top matches for "gizmo automation"');
    expect(r.stdout).toContain("anthropics/skills@gizmo (999999 installs, scan=clean, relevance=");
    // The verdict is still computed and still shown — the knob downgrades it
    // to a question, it does not hide why the package would have qualified.
    expect(r.stdout).toContain("[ask: needs your yes — auto-install is off; publisher anthropics is allowlisted, scan clean]");
    // The command names the package the question above it names. `<pkg>` was
    // a command the model had to edit before running, against Rule 1 ("run
    // the command as printed") — and the live branch never had a placeholder.
    expect(r.stdout).toContain(
      `Install only on the user's explicit yes: "${process.execPath}" "${CLI}" install anthropics/skills@gizmo --force --matched "gizmo automation"`,
    );
    expect(r.stdout).not.toContain("install <pkg>");
    expect(r.stdout).not.toContain("Installed now:");
    // Nothing ran, nothing was recorded, nothing landed on disk.
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    expect(fs.existsSync(path.join(home, ".claude", "skills", "gizmo"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("find prints the same block with auto_install on — installing is install's job", async () => {
    // The knob restores the `auto` VERDICT, not an install from `find`. Two
    // separate properties, and conflating them is how the original defect got
    // in: a decision the policy is willing to make is not the same thing as a
    // command that acts on it unattended.
    const home = freshHome("find-auto-on");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "metaskill.yaml"),
      ["version: 1", "trust:", "  auto_install: true"].join("\n"),
    );
    const idx = writeIndex(home, [
      {
        name: "gizmo", source: "anthropics/skills", pkg: "anthropics/skills@gizmo",
        description: "Gizmo automation toolkit for gizmo workflows.", installs: 999999, installsPrior: null,
        estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [],
      },
    ]);
    const r = await runCli(["find", "gizmo automation", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Top matches for "gizmo automation"');
    expect(r.stdout).toContain("[auto: publisher anthropics is allowlisted, scan clean]");
    expect(r.stdout).not.toContain("auto-install is off");
    expect(r.stdout).not.toContain("Installed now:");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    expect(fs.existsSync(path.join(home, ".claude", "skills", "gizmo"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("install honours the knob: refuses without --force by default, installs with it", async () => {
    // `--force` after an explicit yes is the whole confirmation mechanism —
    // there is no second flag. With the knob off, even the most trusted
    // package needs it; with the knob on, the trusted package installs the
    // way it always did.
    const home = freshHome("install-knob");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "index.json"),
      JSON.stringify(indexFile([rec({ name: "gizmo", source: "anthropics/skills", pkg: "anthropics/skills@gizmo",
                                      description: "Gizmo automation toolkit.", installs: 999999 })])),
    );

    const refused = await runCli(["install", "anthropics/skills@gizmo"], { home });
    expect(refused.code).toBe(1);
    // `Needs confirmation` already names the action, so install.ts strips the
    // reason's own `needs your yes — ` opener at this one wrap site.
    expect(refused.stderr).toContain("Needs confirmation (auto-install is off;");
    expect(refused.stderr).not.toContain("needs your yes");
    expect(refused.stderr).toContain("publisher anthropics is allowlisted, scan clean");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});

    const forced = await runCli(["install", "anthropics/skills@gizmo", "--force"], { home });
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("Installed anthropics/skills@gizmo");
    expect(readLockFile(home)["anthropics/skills@gizmo"]).toMatchObject({ skill: "gizmo", version: "1.2.3" });

    // ...and with the knob on, the same package needs no flag at all.
    const home2 = freshHome("install-knob-on");
    fs.mkdirSync(path.join(home2, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home2, ".metaskill", "metaskill.yaml"),
      ["version: 1", "trust:", "  auto_install: true"].join("\n"),
    );
    fs.writeFileSync(
      path.join(home2, ".metaskill", "index.json"),
      JSON.stringify(indexFile([rec({ name: "gizmo", source: "anthropics/skills", pkg: "anthropics/skills@gizmo",
                                      description: "Gizmo automation toolkit.", installs: 999999 })])),
    );
    const auto = await runCli(["install", "anthropics/skills@gizmo"], { home: home2 });
    expect(auto.code).toBe(0);
    expect(auto.stdout).toContain("Installed anthropics/skills@gizmo");

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
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
    expect(r.stdout).toContain("someorg/repo@snorklex (42 installs, scan=clean, relevance=");
    expect(r.stdout).toContain("otherorg/tools@snorklex-lite (~12 est installs, scan=clean, relevance=");
    expect(r.stdout).toContain("[ask:");
    // relevance is printed so the model can judge the match; two decimals, on
    // every row, whatever the decision.
    expect(r.stdout).toMatch(/relevance=\d\.\d\d\)/);
    expect(r.stdout).toContain(
      `Install only on the user's explicit yes: "${process.execPath}" "${CLI}" install someorg/repo@snorklex --force --matched "snorklex"`,
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The ask that never happened. First real v2 use printed five `ask` rows
  // with a plainly fitting top row (relevance 1.16) and the model asked
  // nothing: asking costs a turn, and the block handed it nothing ready to
  // say. So `find` writes the question out, with the three facts the user
  // needs in order to answer it, and the model's job shrinks to relaying it.
  it("find prints a ready-made question for an ask-tier top row", async () => {
    const home = freshHome("find-question");
    const idx = writeIndex(home, [
      rec({ name: "linkedin-posts", source: "kostja94/marketing-skills",
            pkg: "kostja94/marketing-skills@linkedin-posts",
            description: "Linkedin post copywriting: write a linkedin post, linkedin copywriting for the linkedin post feed.",
            installs: 312 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
    const r = await runCli(["find", "linkedin post copywriting", "--index", idx], { home });
    expect(r.code).toBe(0);
    const question = r.stdout.split("\n").find((l) => l.startsWith("Ask the user: Install "));
    expect(question).toBe(
      "Ask the user: Install kostja94/marketing-skills@linkedin-posts " +
        "(312 installs, publisher kostja94, scan clean) for this task? yes/no",
    );
    // Before the command it is the precondition for, never after it.
    expect(r.stdout.indexOf("Ask the user: Install")).toBeLessThan(
      r.stdout.indexOf("Install only on the user's explicit yes:"),
    );
    // One question about one row, not one question per row.
    expect(r.stdout.match(/Ask the user: Install /g)).toHaveLength(1);
    // This row is the case the protocol's rule fires on (relevance >= 1.0);
    // a fixture that scored below it would pin the line but not the flow.
    const row = r.stdout.split("\n").find((l) => l.includes("kostja94/marketing-skills@linkedin-posts ("))!;
    expect(Number(/relevance=(\d+\.\d+)/.exec(row)![1])).toBeGreaterThanOrEqual(1);
    // Printing a question is still not installing.
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("the question repeats that row's own numbers, estimate marker included", async () => {
    // A question quoting a count the row does not show is a question the user
    // cannot check. `~12 est` is the same string the row prints, from the
    // same helper — an estimate must not reach the user as a fact.
    const home = freshHome("find-question-est");
    const idx = writeIndex(home, [
      rec({ name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex",
            description: "Snorklex data processor for snorklex pipelines and snorklex jobs.",
            installs: null, installsPrior: 12, estimated: true, scan: "unknown" }),
    ]);
    const r = await runCli(["find", "snorklex", "--index", idx], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("someorg/repo@snorklex (~12 est installs, scan=unknown, relevance=");
    expect(r.stdout).toContain(
      "Ask the user: Install someorg/repo@snorklex (~12 est installs, publisher someorg, scan unknown) for this task? yes/no",
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The bands, end to end. The rule lived only in prose for one round, and
  // prose does not gate anything: a top row scoring 0.08 got the same
  // ready-to-relay question as one scoring 1.58, so the cheapest action was
  // "ask" exactly where the rule says be silent — and the question carried no
  // number to catch it on. `find` applies the bands itself now. One fixture,
  // three queries, three lines.
  const bandIndex = (home: string): string =>
    writeIndex(home, [
      rec({ name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex",
            description: "Snorklex processor: snorklex pipelines, snorklex jobs, snorklex runs, snorklex builds.",
            installs: 42 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
  const topRelevance = (stdout: string, pkg: string): number => {
    const row = stdout.split("\n").find((l) => l.includes(`${pkg} (`))!;
    return Number(/relevance=(\d+\.\d+)/.exec(row)![1]);
  };
  // The one line the bands produce. The header names all three labels (it
  // tells the model what each means), so a whole-stdout assertion would match
  // the wrong copy — this reads the line that was actually chosen.
  const verdictLines = (stdout: string): string[] =>
    stdout
      .split("\n")
      .filter((l) => /^(Likely fit|Ask the user: Install|Borderline match|Weak matches only)/.test(l));

  it("band >= 1.0: the description check, then the question, and nothing else", async () => {
    // The question still prints, unchanged and ready to relay — it is the
    // relay when the answer is yes, and composing it was the step the model
    // skipped on the first real v2 lookup. What is new above it is the one
    // check the score cannot make: 26 of 47 everyday queries land in this
    // band against the live index, and most of those top rows are homonyms
    // ("insomnia help" -> a REST client called insomnia). The cue names both
    // outcomes, so neither is a slot for "I could just do this myself".
    const home = freshHome("find-band-ask");
    const r = await runCli(["find", "snorklex processor", "--index", bandIndex(home)], { home });
    expect(topRelevance(r.stdout, "someorg/repo@snorklex")).toBeGreaterThanOrEqual(1);
    expect(verdictLines(r.stdout)).toEqual([
      "Likely fit (relevance 1.40) — read the row's description first: if it fits the task, ask the question below, " +
        "first, via the tool if you have it; if it is a different thing with the same word, say nothing and solve " +
        "the task; if the description is blank or a bare mark (`>`, `|`), you cannot confirm the fit — say nothing " +
        "and solve the task.",
      "Ask the user: Install someorg/repo@snorklex (42 installs, publisher someorg, scan clean) for this task? yes/no",
    ]);
    // A readable description changes nothing: the question and the command
    // print exactly as they did before the unreadable case was carved out.
    expect(r.stdout).toContain(
      `Install only on the user's explicit yes: "${process.execPath}" "${CLI}" install someorg/repo@snorklex --force`,
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("band >= 1.0 with nothing to read: the cue says an unconfirmable fit is not one", async () => {
    // 900 of the shipped snapshot's 4,831 records carry a description that is
    // blank or a bare YAML block mark (`>`, `|`, `>-`) — 18.6% — and 7 of the
    // 44 answerable fixture queries hit one as their TOP row (`insomnia
    // help`, `home workout`, `goal setting`, `public speaking`, `investing
    // basics`, `tax filing personal`, `home organization`). They rank on the
    // skill NAME alone, which is exactly how a name-shaped match reaches a
    // high relevance with no evidence behind it.
    //
    // The index is synthetic because the combination cannot be staged from
    // the snapshot: those seven queries all land in the borderline band
    // there, and it is the larger live index that pushes them up. The
    // mechanism is the same either way — a description of `>` and a `Likely
    // fit` cue above a ready-made question.
    const home = freshHome("find-band-ask-blank");
    const idx = writeIndex(home, [
      rec({ name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex", description: ">", installs: 42 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
    const r = await runCli(["find", "snorklex", "--index", idx], { home });
    expect(topRelevance(r.stdout, "someorg/repo@snorklex")).toBeGreaterThanOrEqual(1);
    // The row prints the mark it has, so the model can see there is nothing
    // to read...
    expect(r.stdout).toContain("someorg/repo@snorklex (42 installs, scan=clean, relevance=");
    // ...and the ONLY line under the rows says so, with no question and no
    // command beneath it. A cue ending "say nothing and solve the task" over
    // a free-standing `Ask the user: Install X?` is the shape that was cut
    // from the weak band: the actionable line wins at reading speed, and the
    // stop instruction above it is decoration. A check that cannot be made
    // must not be followed by the sentence it was there to gate.
    expect(verdictLines(r.stdout)).toEqual([
      "Likely fit (relevance 1.47) — but someorg/repo@snorklex's description is blank or a bare mark (`>`, `|`): " +
        "nothing here can confirm the fit, so no question is printed. Say nothing and solve the task.",
    ]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("Ask the user:"))).toEqual([]);
    expect(r.stdout).not.toContain("Install only on the user's explicit yes:");
    expect(r.stdout).not.toContain(" install someorg/repo@snorklex");
    expect(r.stdout).not.toContain("--force");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("band >= 1.0 with an empty description: same silence, no question, no command", async () => {
    // The other half of the same defect. `""` and `>` reach the index by
    // different routes — a missing key and a YAML block scalar the builder
    // kept the marker of — and one regex covers both, in the one helper the
    // cue text and this gate share.
    const home = freshHome("find-band-ask-empty");
    const idx = writeIndex(home, [
      rec({ name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex", description: "", installs: 42 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
    const r = await runCli(["find", "snorklex", "--index", idx], { home });
    expect(topRelevance(r.stdout, "someorg/repo@snorklex")).toBeGreaterThanOrEqual(1);
    expect(verdictLines(r.stdout)[0]).toContain("nothing here can confirm the fit, so no question is printed.");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("Ask the user:"))).toEqual([]);
    expect(r.stdout).not.toContain("Install only on the user's explicit yes:");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("band 0.5-1.0: prints a judge-first cue, and no question", async () => {
    const home = freshHome("find-band-mid");
    const r = await runCli(["find", "snorklex zorbulon", "--index", bandIndex(home)], { home });
    const rel = topRelevance(r.stdout, "someorg/repo@snorklex");
    expect(rel).toBeGreaterThanOrEqual(0.5);
    expect(rel).toBeLessThan(1);
    // Judgement first, then the finished sentence. "before asking" was
    // satisfied by a model that judged the row to fit and then asked at the
    // end of an answer it had already given (0.85, second real v2 use), so
    // the cue names when — first — and hands over the words, because the one
    // band with no ready-made question is the band that failed. The
    // `Ask the user:` label stays out of it: that label is bound to
    // `relevance` >= 1.0 in all three documents, and printing it here would
    // read as "relay this" exactly where the rule says "judge first".
    expect(verdictLines(r.stdout)).toEqual([
      "Borderline match (relevance 0.53) — judge whether someorg/repo@snorklex fits. " +
        "If it does, ask exactly this, first — via the tool if you have it, else as one line and nothing else: " +
        "Install someorg/repo@snorklex (42 installs, publisher someorg, scan clean) for this task? yes/no",
    ]);
    // The label belongs to the band above this one, and the header names all
    // three bands, so this reads the printed lines, not the whole screen.
    expect(r.stdout.split("\n").filter((l) => l.startsWith("Ask the user:"))).toEqual([]);
    // ...and the row is still printed, with its number. Bands gate the
    // action, never the list.
    expect(r.stdout).toContain("someorg/repo@snorklex (42 installs, scan=clean, relevance=0.53)");
    // The install line stays in this band — the cue ends in "then ask first"
    // — and names the same package the cue does.
    expect(r.stdout).toContain(
      `Install only on the user's explicit yes: "${process.execPath}" "${CLI}" install someorg/repo@snorklex --force`,
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("borderline band with nothing to read: the same silence, no question, no command", async () => {
    // The measured case, not a hypothetical: `insomnia help` scores 0.58
    // against the shipped snapshot and its top row's description is a bare
    // `>`. "Judge whether X fits" over a row with nothing to judge, followed
    // by a ready-made question, is the >= 1.0 defect one band down — the band
    // boundary is about how much of the query matched and says nothing about
    // whether there is any evidence to read. Same helper, same sentence, only
    // the label differs.
    const home = freshHome("find-band-mid-blank");
    const idx = writeIndex(home, [
      rec({ name: "snorklex", source: "someorg/repo", pkg: "someorg/repo@snorklex", description: ">", installs: 42 }),
      // Carries the query's other term once, so `zorbulon` is not a hapax
      // whose idf would drag the top row under 0.5 — and stays far enough
      // behind that the unreadable row is the one the band speaks about.
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Zorbulon widgets.", installs: 20 }),
    ]);
    const r = await runCli(["find", "snorklex zorbulon", "--index", idx], { home });
    const rel = topRelevance(r.stdout, "someorg/repo@snorklex");
    expect(rel).toBeGreaterThanOrEqual(0.5);
    expect(rel).toBeLessThan(1);
    expect(verdictLines(r.stdout)).toEqual([
      `Borderline match (relevance ${rel.toFixed(2)}) — but someorg/repo@snorklex's description is blank or a bare ` +
        "mark (`>`, `|`): nothing here can confirm the fit, so no question is printed. Say nothing and solve the task.",
    ]);
    expect(r.stdout).not.toContain("ask exactly this");
    expect(r.stdout).not.toContain("for this task? yes/no");
    expect(r.stdout).not.toContain("Install only on the user's explicit yes:");
    expect(r.stdout).not.toContain("--force");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("README quotes the header find actually prints", async () => {
    // README's walkthrough pastes find's output verbatim, and nothing checked
    // it: the relevance-rule clause in the header could drift in either
    // document — and did, the moment the borderline cue changed. Only the
    // query differs between the sample and a real run, so only that is
    // substituted.
    const home = freshHome("readme-header");
    const r = await runCli(["find", "snorklex processor", "--index", bandIndex(home)], { home });
    const header = r.stdout.split("\n")[0]!.replace('"snorklex processor"', '"xlsx export formulas"');
    expect(header).toContain("Top matches for");
    expect(fs.readFileSync(path.join(ROOT, "README.md"), "utf8")).toContain(header);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("band < 0.5: says solve it yourself, and no question", async () => {
    const home = freshHome("find-band-weak");
    const r = await runCli(["find", "snorklex zorbulon flimscape", "--index", bandIndex(home)], { home });
    expect(topRelevance(r.stdout, "someorg/repo@snorklex")).toBeLessThan(0.5);
    expect(verdictLines(r.stdout)).toEqual([
      "Weak matches only (top relevance 0.31) — solve the task yourself.",
    ]);
    // No question in any form down here: neither the labelled one nor the
    // bare sentence the borderline band hands over. (The header names every
    // band, so the label is read off the printed lines, not the screen.)
    expect(r.stdout.split("\n").filter((l) => l.startsWith("Ask the user:"))).toEqual([]);
    expect(r.stdout).not.toContain("ask exactly this");
    expect(r.stdout).not.toContain("for this task? yes/no");
    // ...and no install command under it. Left in place it was the only
    // actionable line on screen, one line below "solve the task yourself",
    // with exactly one askable package named above it.
    expect(r.stdout).not.toContain("Install only on the user's explicit yes:");
    expect(r.stdout).not.toContain("--force");
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
    expect(r3.stdout).toContain("[ask: needs your yes — auto-install is off;");
    fs.rmSync(home, { recursive: true, force: true });
  });
});

// Everyday life and work queries, ranked against the SHIPPED SNAPSHOT, with
// the top package recorded once by hand (test/fixtures/everyday-queries.json)
// so ranking drift on them is loud rather than silent.
//
// Every other ranking test in this file builds a 2-4 row index and asserts a
// property of the algorithm. None of them can see what a real 4,831-skill
// corpus does to "insomnia help" or "stress management" — and that is where
// the interesting failure lives: a rare query word carries high idf, so the
// wrong sense of it outranks everything, and BM25 has no way to know. The
// fixture is the measurement; the wording change in task 18 is the response
// to it, and this test is what tells us when the measurement moves.
//
// The snapshot is gitignored (built by `npm run snapshot` at publish time),
// so this SKIPS rather than fails where it is absent — a CI checkout must not
// go red over a file it was never given.
describe("find: everyday queries against the shipped snapshot (golden fixture)", () => {
  const SNAPSHOT = path.join(ROOT, "index-snapshot.json");
  const fixture = JSON.parse(
    fs.readFileSync(path.join(ROOT, "test", "fixtures", "everyday-queries.json"), "utf8"),
  ) as { note: string; queries: { query: string; pkg: string | null; homonym: boolean }[] };

  // This one guards the fixture's integrity and RECORDS a measurement; it is
  // not a behaviour of `src/`. No change to the ranking code can break the
  // homonym count — the flags are hand-set and travel with the file — so read
  // a failure here as "the fixture was edited", never as "the product
  // regressed". It is worth asserting anyway: the majority is the finding the
  // description check is priced against, and someone editing these flags down
  // to a handful should have to mean it.
  it("documents the measured probe: 47 unique queries, well-formed flags, homonyms in the majority", () => {
    expect(fixture.queries).toHaveLength(47);
    expect(new Set(fixture.queries.map((q) => q.query)).size).toBe(47);
    for (const q of fixture.queries) expect(typeof q.homonym, q.query).toBe("boolean");
    expect(fixture.queries.filter((q) => q.homonym).length).toBeGreaterThan(
      fixture.queries.length / 2,
    );
  });

  it("ranks every fixture query to the package the fixture recorded", (ctx) => {
    if (!fs.existsSync(SNAPSHOT)) {
      ctx.skip(`${SNAPSHOT} is absent — run \`npm run snapshot\` to check everyday-query ranking drift`);
      return;
    }
    // The snapshot by explicit path, never loadIndex()'s default lookup: this
    // must not silently rank against a developer's ~/.metaskill/index.json.
    const index = loadIndex(SNAPSHOT);
    expect(index, "the snapshot parsed as an index").not.toBeNull();
    const actual = fixture.queries.map((q) => ({
      query: q.query,
      pkg: search(index!, normaliseQuery(q.query), 5)[0]?.record.pkg ?? null,
    }));
    expect(actual).toEqual(fixture.queries.map((q) => ({ query: q.query, pkg: q.pkg })));
  });
});

describe("find: ranking is a signal, not an action", () => {
  // Two mechanisms used to live here and both are gone, because both were
  // patches on the same wrong shape — `find` deciding what to install.
  // "Only the top-ranked hit may auto-install" narrowed which junk installed;
  // the MIN_RELEVANCE floor tried to reject junk queries outright, and could
  // not: measured against the shipped snapshot the junk and capability
  // relevance distributions overlap (junk max 1.298, capability min 0.850),
  // so any floor strict enough to stop "say hello" silenced 24 of 25 real
  // phrases. Judging relevance is the model's job. `find` reports and stops.

  it("prints a weak junk match with its relevance instead of installing or hiding it", async () => {
    const home = freshHome("find-weak");
    const idx = writeIndex(home, [
      // Allowlisted + clean, so policy would have said `auto` the moment
      // anything reached it. Only "hello" of the query is in this
      // description, so the hit is a fragment of a match, not a match.
      rec({ name: "cardputer-buddy", source: "anthropics/plugins", pkg: "anthropics/plugins@cardputer-buddy",
            description: "Say hello to your handheld device companion.", installs: 900 }),
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape.", installs: 20 }),
    ]);
    const r = await runCli(["find", "say hello zorbulon", "--index", idx], { home });
    expect(r.code).toBe(0);
    // The row is shown, with the number that says how weak it is — the model
    // reads that and declines. Nothing is installed either way.
    expect(r.stdout).toContain("anthropics/plugins@cardputer-buddy");
    const rel = /relevance=(\d\.\d\d)\)/.exec(r.stdout);
    expect(rel).not.toBeNull();
    expect(Number(rel![1])).toBeLessThan(0.8);
    expect(r.stdout).toContain("find does not install");
    expect(r.stdout).not.toContain("Installed now:");
    // A local hit, however weak, is still a hit: no live search runs.
    expect(stubCalls(home)).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("shows a lower-ranked trusted row without acting on it", async () => {
    // The measured failure: on 25 real capability phrases, 11 installed a row
    // that was not the top match, purely because policy happened to bless it.
    // Both rows are offered now, in rank order, and neither is installed.
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
    const first = r.stdout.indexOf("someorg/repo@zorptastic-pro");
    const second = r.stdout.indexOf("anthropics/skills@zorptastic ");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first); // rank order preserved
    expect(r.stdout).toContain("[ask: needs your yes — publisher someorg not allowlisted]");
    expect(r.stdout).toContain("[ask: needs your yes — auto-install is off; publisher anthropics is allowlisted, scan clean]");
    expect(stubCalls(home).filter((c) => c[0] === "add")).toEqual([]);
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("never lists a denied package under the ask header or beside an install command", async () => {
    // `deny` rows printed under the ask header, above a line reading
    // `install <the askable package> --force`, invite the model to go get
    // approval for something no flag can install.
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
    const askHeader = r.stdout.indexOf("find does not install");
    const forceLine = r.stdout.indexOf("install someorg/repo@flumbex-lite --force");
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
    expect(r.stdout).not.toContain("find does not install");
    expect(r.stdout).not.toContain("Install only on the user's explicit yes:");
    // No askable row, so there is nothing to ask about. A question naming a
    // package no flag can install is a wasted turn ending in a failed command.
    expect(r.stdout).not.toContain("Ask the user: Install");
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("--force still cannot install a package the index scans dirty, knob on or off", async () => {
    // deny is deny. The knob lowers what may happen unattended; it has no
    // power over the tier above it, and neither does the flag.
    const home = freshHome("find-deny-force");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "metaskill.yaml"),
      ["version: 1", "trust:", "  auto_install: true"].join("\n"),
    );
    fs.writeFileSync(
      path.join(home, ".metaskill", "index.json"),
      JSON.stringify(indexFile([rec({ name: "flumbex", source: "anthropics/skills",
                                      pkg: "anthropics/skills@flumbex", description: "Flumbex processor.",
                                      installs: 999999, scan: "dirty",
                                      scanFindings: ["os.environ in script.py"] })])),
    );
    const forced = await runCli(["install", "anthropics/skills@flumbex", "--force"], { home });
    expect(forced.code).toBe(1);
    expect(forced.stderr).toContain("DENIED:");
    expect(forced.stderr).toContain("`deny` cannot be bypassed by any flag.");

    // Same for a publisher-level deny, with the knob at its default.
    const home2 = freshHome("find-deny-list");
    fs.mkdirSync(path.join(home2, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home2, ".metaskill", "metaskill.yaml"),
      ["version: 1", "trust:", "  deny_skills: [anthropics/skills@gizmo]"].join("\n"),
    );
    fs.writeFileSync(
      path.join(home2, ".metaskill", "index.json"),
      JSON.stringify(indexFile([rec({ name: "gizmo", source: "anthropics/skills",
                                      pkg: "anthropics/skills@gizmo", description: "Gizmo toolkit.",
                                      installs: 999999 })])),
    );
    const denied2 = await runCli(["install", "anthropics/skills@gizmo", "--force"], { home: home2 });
    expect(denied2.code).toBe(1);
    expect(denied2.stderr).toContain("is in deny_skills");
    expect(stubCalls(home2).filter((c) => c[0] === "add")).toEqual([]);

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(home2, { recursive: true, force: true });
  });
});

describe("find: logs what it found, not just the query (task 14)", () => {
  // A user reading `domains=[find:linkedin post copywriting] 54ms` on its own
  // read it as "found nothing" — `logFind` wrote `discovered: []`
  // unconditionally, so the log could not answer the first question anyone
  // asks of it. These pin every `discovered` shape `find` can now write.
  function readLastLog(home: string): any {
    const raw = fs.readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    return JSON.parse(raw[raw.length - 1]!);
  }

  it("find logs every printed hit with its decision, in the order it printed them", async () => {
    const home = freshHome("find-log-hits");
    const idx = writeIndex(home, [
      // Dirty scan: `deny`, whatever else is true of the row — and ranked
      // FIRST here (most "gadgetfoo" repeats), which is the case that tells
      // the two candidate orders apart. The log used to be written in search
      // rank order while stdout prints askable rows first and the refused
      // block last, so a reader lining the log up against what they saw got
      // rows in an order that appeared nowhere on screen.
      rec({ name: "gadgetfoo-old", source: "otherorg/tools", pkg: "otherorg/tools@gadgetfoo-old",
            description: "Gadgetfoo legacy: gadgetfoo tool for gadgetfoo jobs, gadgetfoo builds, gadgetfoo runs.",
            installs: 999999, scan: "dirty", scanFindings: ["eval( in script.py"] }),
      // Allowlisted + clean + a real install count: decide() computes `auto`,
      // and trust.auto_install is off by default, so this prints (and must
      // log) `ask`.
      rec({ name: "gadgetfoo-pro", source: "anthropics/skills", pkg: "anthropics/skills@gadgetfoo-pro",
            description: "Gadgetfoo automation: gadgetfoo toolkit for gadgetfoo pipelines.",
            installs: 999999 }),
      // Estimated installs: `ask`, ahead of any allowlist check
      // (policy.ts's verdictFor), whatever the publisher.
      rec({ name: "gadgetfoo-lite", source: "someorg/repo", pkg: "someorg/repo@gadgetfoo-lite",
            description: "Lightweight gadgetfoo helper for gadgetfoo tasks.",
            installs: null, installsPrior: 20, estimated: true }),
    ]);
    const r = await runCli(["find", "gadgetfoo", "--index", idx], { home });
    expect(r.code).toBe(0);
    // The denied row outranks both askable rows — relevance says so — and
    // still prints last, under "Refused by policy".
    const relOf = (pkg: string): number => {
      const row = r.stdout.split("\n").find((l) => l.includes(`${pkg} (`))!;
      return Number(/relevance=(\d+\.\d+)/.exec(row)![1]);
    };
    expect(relOf("otherorg/tools@gadgetfoo-old")).toBeGreaterThan(relOf("anthropics/skills@gadgetfoo-pro"));
    const posPro = r.stdout.indexOf("anthropics/skills@gadgetfoo-pro");
    const posLite = r.stdout.indexOf("someorg/repo@gadgetfoo-lite");
    const posOld = r.stdout.indexOf("otherorg/tools@gadgetfoo-old");
    expect(posPro).toBeGreaterThanOrEqual(0);
    expect(posLite).toBeGreaterThan(posPro);
    expect(posOld).toBeGreaterThan(posLite);

    const log = readLastLog(home);
    expect(log.covered).toEqual([]);
    expect(log.installed).toEqual([]);
    // Exactly the stdout order above: askable rows in rank order, then the
    // refused ones.
    expect(log.discovered).toEqual([
      { pkg: "anthropics/skills@gadgetfoo-pro", installs: 999999, publisher: "anthropics", decision: "ask", scan: "clean" },
      { pkg: "someorg/repo@gadgetfoo-lite", installs: 20, publisher: "someorg", decision: "ask", scan: "clean" },
      { pkg: "otherorg/tools@gadgetfoo-old", installs: 999999, publisher: "otherorg", decision: "deny", scan: "dirty" },
    ]);
    // The question names the top ASKABLE row: a denied row above it is not
    // askable at any relevance, and no flag installs it.
    expect(r.stdout).toContain(
      "Ask the user: Install anthropics/skills@gadgetfoo-pro (999999 installs, publisher anthropics, scan clean) for this task? yes/no",
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("find logs the live-fallback candidate and nothing on did-not-answer", async () => {
    const home = freshHome("find-log-live");
    // No index.json seeded: loadIndex() finds nothing, so `find` falls
    // through to the live search against the stub's "reddit" fixture — same
    // setup as the live-fallback round-trip test above.
    const found = await runCli(["find", "reddit"], { home });
    expect(found.code).toBe(0);
    expect(found.stdout).toContain("live search found modelscope.cn@reddit-helper");
    // The protocol promises a printed question on this branch too. A registry
    // hit has no relevance to band and no scan verdict, so it is always
    // askable and always gets one; a branch that printed none would teach the
    // model the promise is unreliable.
    expect(found.stdout).toContain(
      "Ask the user: Install modelscope.cn@reddit-helper (146100 installs, publisher modelscope.cn, scan unavailable) for this task? yes/no",
    );
    expect(found.stdout.indexOf("Ask the user: Install")).toBeLessThan(
      found.stdout.indexOf("On the user's explicit yes run:"),
    );
    expect(readLastLog(home).discovered).toEqual([
      { pkg: "modelscope.cn@reddit-helper", installs: 146100, publisher: "modelscope.cn", decision: "ask", scan: "unavailable" },
    ]);

    // A different query (distinct cache key), stubbed to fail outright: the
    // registry never answered, which is not the same fact as "found nothing"
    // and must not be logged as though something was found and refused.
    const failed = await runCli(["find", "zzqq nomatch"], { home, env: { STUB_FIND_FAIL: "1" } });
    expect(failed.code).toBe(0);
    expect(failed.stdout).toContain("Registry did not answer");
    expect(readLastLog(home).discovered).toEqual([]);
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

  it("short-circuits a repeat of the phrase a lock entry records, via the lock", async () => {
    // `find` no longer installs, so nothing writes LockEntry.domain today —
    // but locks written by earlier versions carry it, and the shortcut those
    // users earned must keep working. Seeded here the way `list`'s
    // old-lock-entry test seeds one, rather than by having find install.
    const home = freshHome("find-present-lock");
    installSkillOnDisk(home, "sheetwrangler");
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".metaskill", "skills-lock.json"),
      JSON.stringify({
        "anthropics/skills@sheetwrangler": {
          pkg: "anthropics/skills@sheetwrangler",
          skill: "sheetwrangler",
          installedAt: "2026-08-01T00:00:00Z",
          version: "1.2.3",
          domain: "excel spreadsheets",
        },
      }),
    );
    const idx = writeIndex(home, [
      rec({ name: "sheetwrangler", source: "anthropics/skills", pkg: "anthropics/skills@sheetwrangler",
            description: "Excel spreadsheets toolkit: excel spreadsheets formulas and excel spreadsheets charts.",
            installs: 999999 }),
    ]);
    // The skill is named nothing like the query, so only the lock can answer
    // this — and it must, rather than sending the model back to the index for
    // a package it already has.
    const r = await runCli(["find", "excel spreadsheets", "--index", idx], { home });
    expect(r.stdout).toContain("Already present: sheetwrangler");
    expect(r.stdout).not.toContain("Top matches");
    expect(stubCalls(home)).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("find -> install --matched: the phrase a confirmed install records", () => {
  // Both `find` (default lookup, no --index) and `install` (no --index flag
  // at all) resolve the local index through the same METASKILL_INDEX env var
  // runCli sets for every spawned process — see its comment above — so
  // seeding it here, rather than through writeIndex's own `home/index.json`,
  // is what lets one seeded index answer both commands in the same test.
  function seedIndex(home: string, skills: unknown[]): void {
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.writeFileSync(path.join(home, ".metaskill", "index.json"), JSON.stringify(indexFile(skills)));
  }

  it("a find -> install --matched round trip lands the phrase under MATCHED", async () => {
    const home = freshHome("find-install-roundtrip");
    seedIndex(home, [
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape with formatting presets.", installs: 500 }),
    ]);

    const found = await runCli(["find", "Widget Press  formatting!"], { home });
    expect(found.code).toBe(0);
    expect(found.stdout).toContain('Top matches for "widget press formatting"');

    // Parse the printed command instead of assuming its shape — exactly what
    // the model does before running it.
    const cmdLine = found.stdout.split("\n").find((l) => l.includes("Install only on the user's explicit yes:"));
    expect(cmdLine).toBeDefined();
    const matchedArg = /--matched "([^"]*)"/.exec(cmdLine!)?.[1];
    expect(matchedArg).toBe("widget press formatting");
    // The package is printed, not a placeholder: the model runs this line as
    // it stands (SKILL.md Rule 1), it does not fill anything in.
    const pkgArg = /install (\S+) --force/.exec(cmdLine!)?.[1];
    expect(pkgArg).toBe("acme/tools@widget-press");

    const installed = await runCli(
      ["install", pkgArg!, "--force", "--matched", matchedArg!],
      { home },
    );
    expect(installed.code).toBe(0);
    expect(readLockFile(home)["acme/tools@widget-press"]).toMatchObject({ domain: "widget press formatting" });

    const list = await runCli(["list"], { home });
    expect(list.stdout).toMatch(
      /^widget-press\s+acme\/tools@widget-press\s+v1\.2\.3\s+widget press formatting\s+/m,
    );
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("the live-fallback branch (no local index hit) also carries --matched through", async () => {
    // Fix round 1: this branch printed `install <pkg> --force` with no
    // --matched at all, so a live-only hit's lock entry never got a domain
    // and `list` showed "-" under MATCHED — the exact symptom this task
    // exists to remove, just reached via the OTHER of find's two "confirmed
    // install" branches. No index.json is seeded at all (loadIndex() reads
    // METASKILL_INDEX, finds nothing, returns null), so `find` gets zero
    // local hits and falls through to the live search against the stub's
    // "reddit" fixture instead of the ranked "Top matches" branch above.
    const home = freshHome("find-install-live-roundtrip");

    const found = await runCli(["find", "reddit"], { home });
    expect(found.code).toBe(0);
    expect(found.stdout).toContain("live search found modelscope.cn@reddit-helper");

    const cmdLine = found.stdout.split("\n").find((l) => l.includes("On the user's explicit yes run:"));
    expect(cmdLine).toBeDefined();
    const pkgMatch = /install (\S+@\S+) --force/.exec(cmdLine!);
    expect(pkgMatch?.[1]).toBe("modelscope.cn@reddit-helper");
    const matchedArg = /--matched "([^"]*)"/.exec(cmdLine!)?.[1];
    expect(matchedArg).toBe("reddit");

    const installed = await runCli(
      ["install", pkgMatch![1]!, "--force", "--matched", matchedArg!],
      { home },
    );
    expect(installed.code).toBe(0);
    expect(readLockFile(home)["modelscope.cn@reddit-helper"]).toMatchObject({ domain: "reddit" });

    const list = await runCli(["list"], { home });
    expect(list.stdout).toMatch(/^reddit-helper\s+modelscope\.cn@reddit-helper\s+v1\.2\.3\s+reddit\s+/m);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("install sanitises --matched exactly as find sanitises its query", async () => {
    const home = freshHome("install-matched-sanitise");
    seedIndex(home, [
      rec({ name: "widget-press", source: "acme/tools", pkg: "acme/tools@widget-press",
            description: "Press widgets into shape with formatting presets.", installs: 500 }),
    ]);

    const installed = await runCli(
      ["install", "acme/tools@widget-press", "--force", "--matched", "  Widget PRESS  formatting!! "],
      { home },
    );
    expect(installed.code).toBe(0);
    expect(readLockFile(home)["acme/tools@widget-press"]).toMatchObject({ domain: "widget press formatting" });

    // A following find for the normalised phrase short-circuits via the
    // lock (alreadyPresent in find.ts), never touching the index or running
    // a live registry lookup through the stub.
    const found = await runCli(["find", "widget press formatting"], { home });
    expect(found.stdout).toContain("Already present: widget-press");
    expect(stubCalls(home).filter((c) => c[0] === "find")).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("install logs one row per successful install and none on refusal", async () => {
    const home = freshHome("install-log-rows");
    seedIndex(home, [
      rec({ name: "gizmo", source: "anthropics/skills", pkg: "anthropics/skills@gizmo",
            description: "Gizmo automation toolkit.", installs: 999999 }),
    ]);
    const logPath = path.join(home, ".metaskill", "log.jsonl");
    const readLog = (): any[] =>
      fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [];

    // trust.auto_install is off by default, so without --force this is a
    // refusal (not a success) and must log nothing.
    const refused = await runCli(["install", "anthropics/skills@gizmo"], { home });
    expect(refused.code).toBe(1);
    expect(readLog()).toEqual([]);

    const forced = await runCli(["install", "anthropics/skills@gizmo", "--force"], { home });
    expect(forced.code).toBe(0);
    const log = readLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      session: "install",
      domains: ["install:anthropics/skills@gizmo"],
      installed: ["anthropics/skills@gizmo"],
    });
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

  // installSelfCopy's entry loop (dist, skills, commands, templates,
  // package.json) never named index-snapshot.json, so every re-init on the
  // npm channel silently deleted the offline search floor `find` reads
  // before the first `sync` — surfaced three times. These run a copy of the
  // CLI from a temp package root (see tempPackage above) so packageRoot(),
  // and with it the snapshot's source path, resolves inside the sandbox
  // instead of the checkout's own gitignored index-snapshot.json.

  it("init copies the index snapshot into the stable engine dir", async () => {
    const home = freshHome("init-snapshot");
    const snapshot = indexFile([rec({ name: "snap", source: "o/r", pkg: "o/r@snap" })]);
    const cli = tempPackage("init-snapshot", snapshot);
    const pkgRoot = path.dirname(path.dirname(cli)); // <root>/dist/cli.js -> <root>
    const r = await runCli(["init"], { home, cli });
    expect(r.code).toBe(0);
    const dst = path.join(home, ".metaskill", "bin", "index-snapshot.json");
    expect(r.stdout).toContain(`Index snapshot: ${dst}`);
    expect(fs.existsSync(dst)).toBe(true);
    const same = fs.readFileSync(dst).equals(fs.readFileSync(path.join(pkgRoot, "index-snapshot.json")));
    expect(same).toBe(true);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("init warns, and still succeeds, when no snapshot is present", async () => {
    const home = freshHome("init-no-snapshot");
    const cli = tempPackage("init-no-snapshot"); // no snapshot arg -> file absent in the package root
    const r = await runCli(["init"], { home, cli });
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("index-snapshot.json");
    expect(combined).toContain("npm run snapshot");
    expect(fs.existsSync(path.join(home, ".metaskill", "bin", "index-snapshot.json"))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("re-running init keeps the snapshot", async () => {
    const home = freshHome("init-snapshot-rerun");
    const snapshot = indexFile([rec({ name: "snap", source: "o/r", pkg: "o/r@snap" })]);
    const cli = tempPackage("init-snapshot-rerun", snapshot);
    const dst = path.join(home, ".metaskill", "bin", "index-snapshot.json");

    const r1 = await runCli(["init"], { home, cli });
    expect(r1.code).toBe(0);
    expect(fs.existsSync(dst)).toBe(true);

    const r2 = await runCli(["init"], { home, cli });
    expect(r2.code).toBe(0);
    expect(fs.existsSync(dst)).toBe(true);
    expect(r2.stdout).toContain(`Index snapshot: ${dst}`);
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
    // --force because trust.auto_install is off by default: a clean verdict
    // from an allowlisted publisher is now an `ask`, and the flag is the
    // user's yes. What this test pins is the absence of a live scan, which is
    // unaffected by it.
    const r = await runCli(["install", "anthropics/skills@xlsx", "--force"], { home });
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
    // --force stands in for the user's yes: with trust.auto_install off (the
    // default) nothing installs without one, allowlisted and clean or not.
    await runCli(["install", "anthropics/skills@xlsx", "--force"], { home });
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

  // The copy a user reads BEFORE installing metaskill. All three said
  // "finds, vets and installs the skills each task needs" / "installs them
  // safely", which stopped being true when `find` became rank-only and
  // trust.auto_install shipped off: the storefront was promising an
  // unattended install the product no longer performs. Nothing pinned these
  // strings, which is how they drifted past a green suite.
  it("the storefront copy promises no install the product will not do unattended", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    const copy: Array<[string, string]> = [
      ["package.json", pkg.description],
      [".claude-plugin/plugin.json", plugin.description],
      ["marketplace.json (marketplace)", market.description],
      ["marketplace.json (plugin entry)", market.plugins[0].description],
    ];
    for (const [where, text] of copy) {
      expect(text, where).toBeTruthy();
      // No unqualified "and installs …" claim.
      expect(text, where).not.toMatch(/vets and installs|installs them safely/i);
      // …and the user's consent is named, not implied.
      expect(text, where).toMatch(/\byes\b/i);
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
