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
  opts: { home: string; cwd?: string; input?: string; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? opts.home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: opts.home,
        METASKILL_HOME: path.join(opts.home, ".metaskill"),
        METASKILL_SKILLS_CMD: `"${process.execPath}" "${STUB}"`,
        STUB_LOG: path.join(opts.home, "stub-calls.log"),
        ANTHROPIC_API_KEY: "", // LLM off in tests
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

function readLockFile(home: string): Record<string, { skill: string; version?: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "skills-lock.json"), "utf8"));
  } catch {
    return {};
  }
}

function hookInput(prompt: string, cwd: string, field = "user_prompt"): string {
  return JSON.stringify({ session_id: "test-session", cwd, [field]: prompt, hook_event_name: "UserPromptSubmit" });
}

describe("route end-to-end (stubbed skills CLI)", () => {
  it("installs an allowlisted skill, asks about an unknown publisher, logs everything", async () => {
    const home = freshHome("route");
    const project = path.join(home, "proj");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), "{}");

    const r = await runCli(["route"], {
      home,
      input: hookInput("export the report to xlsx with formulas and conditional formatting", project),
    });
    expect(r.code).toBe(0);

    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("[metaskill] Domains:");
    expect(ctx).toContain("xlsx");
    expect(ctx).toContain("Installed now: anthropics/skills@xlsx (v1.2.3)");
    expect(ctx).toContain(`${path.join("skills", "xlsx", "SKILL.md")}`);
    // node domain (from stack) resolved to a non-allowlisted registry package -> ask
    expect(ctx).toContain("Needs confirmation: modelscope.cn@node-helper (410 installs");
    expect(ctx.length).toBeLessThanOrEqual(600);

    // physical install through the stub: agents dir + symlink into ~/.claude
    expect(fs.existsSync(path.join(home, ".claude", "skills", "xlsx", "SKILL.md"))).toBe(true);

    const lock = readLockFile(home);
    expect(lock["anthropics/skills@xlsx"]).toMatchObject({ skill: "xlsx", version: "1.2.3" });
    expect(lock["modelscope.cn@node-helper"]).toBeUndefined(); // ask never installs

    const log = fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0].domains).toContain("xlsx");
    expect(log[0].domains).toContain("node");
    expect(log[0].installed).toEqual(["anthropics/skills@xlsx"]);
    expect(log[0].llm_used).toBe(false);
    expect(log[0].prompt_hash).toMatch(/^sha256:/);
    const decisions = Object.fromEntries(log[0].discovered.map((d: any) => [d.pkg, d.decision]));
    expect(decisions["anthropics/skills@xlsx"]).toBe("auto");
    expect(decisions["modelscope.cn@node-helper"]).toBe("ask");

    // Second identical prompt: covered via domainMap + discovery cache.
    const addsBefore = stubCalls(home).filter((c) => c[0] === "add").length;
    const findsBefore = stubCalls(home).filter((c) => c[0] === "find").length;
    const r2 = await runCli(["route"], {
      home,
      input: hookInput("export the report to xlsx with formulas and conditional formatting", project),
    });
    const ctx2 = (JSON.parse(r2.stdout) as any).hookSpecificOutput.additionalContext as string;
    expect(ctx2).toContain("Already present: xlsx");
    expect(ctx2).not.toContain("Installed now:");
    expect(stubCalls(home).filter((c) => c[0] === "add").length).toBe(addsBefore); // no reinstall
    expect(stubCalls(home).filter((c) => c[0] === "find").length).toBe(findsBefore); // cache hit
    expect(r2.ms, `cache-hit route took ${r2.ms}ms`).toBeLessThan(1500); // spec 4.2 budget

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("trivial prompt: no output, no log, no skills CLI calls", async () => {
    const home = freshHome("trivial");
    const r = await runCli(["route"], { home, input: hookInput("hi", home) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(path.join(home, ".metaskill", "log.jsonl"))).toBe(false);
    expect(stubCalls(home)).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("no candidates: solves silently, logs the coverage gap (legacy `prompt` stdin field)", async () => {
    const home = freshHome("gap");
    const r = await runCli(["route"], { home, input: hookInput("convert this docx to pdf", home, "prompt") });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(""); // report nothing (spec 4.8)
    const log = fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log[0].domains.sort()).toEqual(["docx", "pdf"]);
    expect(log[0].discovered).toEqual([]);
    expect(log[0].installed).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("install timeout downgrades to ask (spec 4.2.6)", async () => {
    const home = freshHome("timeout");
    const r = await runCli(["route"], {
      home,
      input: hookInput("export the report to xlsx with formulas", home),
      env: { METASKILL_INSTALL_TIMEOUT_MS: "500", STUB_ADD_SLEEP_MS: "5000" },
    });
    const ctx = (JSON.parse(r.stdout) as any).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("Needs confirmation: anthropics/skills@xlsx");
    expect(ctx).toContain("install timed out");
    expect(readLockFile(home)).toEqual({});
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("classification miss: logs it and asks the in-session model to classify (no API key needed)", async () => {
    const home = freshHome("miss");
    const r = await runCli(["route"], {
      home,
      input: hookInput("please figure out why everything broke yesterday evening and what changed", home),
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Task not classified");
    expect(ctx).toContain('route --search'); // model derives the capability phrase itself
    expect(ctx.length).toBeLessThanOrEqual(600);
    const log = fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0].domains).toEqual([]);
    expect(log[0].llm_used).toBe(false); // no API key in tests
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("route --search: free registry search through the same policy path", async () => {
    const home = freshHome("search");
    // allowlisted top candidate -> auto-install, plain output
    const auto = await runCli(["route", "--search", "xlsx spreadsheets"], { home });
    expect(auto.code).toBe(0);
    expect(auto.stdout).toContain("Installed now: anthropics/skills@xlsx");
    expect(readLockFile(home)["anthropics/skills@xlsx"]).toBeTruthy();

    // unknown publisher, unscannable -> ask, never auto (146K installs is not enough)
    const ask = await runCli(["route", "--search", "Reddit Automation!!"], { home });
    expect(ask.code).toBe(0);
    expect(ask.stdout).toContain("Needs confirmation: modelscope.cn@reddit-helper (146100 installs");
    expect(readLockFile(home)["modelscope.cn@reddit-helper"]).toBeUndefined();

    // nothing found -> says so, still exit 0
    const none = await runCli(["route", "--search", "totally unknown capability"], { home });
    expect(none.stdout).toContain("No skills found");

    // reinstall protection: repeating the search hits the installed skill
    // by query words, before any registry call
    const findsBefore = stubCalls(home).filter((c) => c[0] === "find").length;
    const again = await runCli(["route", "--search", "xlsx spreadsheets"], { home });
    expect(again.stdout).toContain("Already present: xlsx");
    expect(stubCalls(home).filter((c) => c[0] === "find").length).toBe(findsBefore);

    // logged with search: prefix, prompt text never stored
    const log = fs
      .readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((e) => e.domains[0])).toEqual([
      "search:xlsx spreadsheets",
      "search:reddit automation",
      "search:totally unknown capability",
      "search:xlsx spreadsheets",
    ]);
    expect(log[3].covered).toEqual(["xlsx"]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("route --domains: model-side classification installs through the same policy path", async () => {
    const home = freshHome("domains");
    const r = await runCli(["route", "--domains", "xlsx"], { home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[metaskill] Domains: xlsx.");
    expect(r.stdout).toContain("Installed now: anthropics/skills@xlsx");
    expect(r.stdout).not.toContain("hookSpecificOutput"); // plain text, not hook JSON
    expect(readLockFile(home)["anthropics/skills@xlsx"]).toBeTruthy();

    const bad = await runCli(["route", "--domains", "nonsense"], { home });
    expect(bad.code).toBe(2);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("system traffic (notifications, command output) never triggers installs", async () => {
    const home = freshHome("systraffic");
    const r = await runCli(["route"], {
      home,
      input: hookInput(
        "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>report: pdf 185K, xlsx 158K, python 149K installs</task-notification>",
        home,
      ),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(stubCalls(home)).toEqual([]); // no find, no add
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
    expect(s1.hooks.SessionStart[0].matcher).toBe("startup|resume");
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
    const out = JSON.parse(r.stdout) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("Updated skills: xlsx");
    expect(out.hookSpecificOutput.additionalContext).toContain("baz");

    // stub was asked to update ONLY the allowlisted skill
    const updates = stubCalls(home).filter((c) => c[0] === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("xlsx");
    expect(updates[0]).not.toContain("baz");

    expect(readLockFile(home)["anthropics/skills@xlsx"]!.version).toBe("9.9.9");
    expect(readLockFile(home)["foo/bar@baz"]!.version).toBe("0.1.0");

    // second run within 24h: gated, silent
    const r2 = await runCli(["sync"], { home, env: { STUB_UPDATE_VERSION: "9.9.9" } });
    expect(r2.stdout).toBe("");
    expect(stubCalls(home).filter((c) => c[0] === "update")).toHaveLength(1);
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

describe("list command", () => {
  it("shows what metaskill installed, with on-disk status and alias", async () => {
    const home = freshHome("list");
    const empty = await runCli(["list"], { home });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("hasn't installed anything yet");

    await runCli(["route"], { home, input: hookInput("export the report to xlsx with formulas", home) });
    const r = await runCli(["list"], { home });
    expect(r.stdout).toMatch(/SKILL\s+PACKAGE\s+VERSION\s+DOMAIN\s+INSTALLED\s+STATUS/);
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

    const market = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(market.plugins[0].source).toEqual({ source: "npm", package: pkg.name });

    // slash commands must resolve the CLI without init-time templating
    for (const f of fs.readdirSync(path.join(ROOT, "commands"))) {
      const body = fs.readFileSync(path.join(ROOT, "commands", f), "utf8");
      expect(body, f).toContain("CLAUDE_PLUGIN_ROOT");
      expect(body, f).not.toContain("{{");
    }

    // everything the plugin needs must ship in the npm tarball
    for (const entry of ["dist", "skills", "commands", "hooks", "templates", ".claude-plugin"]) {
      expect(pkg.files, entry).toContain(entry);
    }
  });

  it("SKILL.md stays within the 1500-token budget (spec 4.8)", () => {
    const md = fs.readFileSync(path.join(ROOT, "skills", "metaskill", "SKILL.md"), "utf8");
    // ~4 chars/token upper bound: 6000 chars ≈ 1500 tokens
    expect(md.length).toBeLessThanOrEqual(6000);
    expect(md).toContain("metaskill install");
    expect(md).toContain("one");
  });
});
