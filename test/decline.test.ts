import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DECLINE_DAYS } from "../src/declines.js";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const STUB = path.join(ROOT, "test", "fixtures", "skills-stub.mjs");

function runCli(args: string[], home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        METASKILL_HOME: path.join(home, ".metaskill"),
        METASKILL_SKILLS_CMD: `"${process.execPath}" "${STUB}"`,
        STUB_LOG: path.join(home, "stub-calls.log"),
        METASKILL_SKIP_INDEX_REFRESH: "1",
        METASKILL_INDEX: path.join(home, ".metaskill", "index.json"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end("");
  });
}

function freshHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `metaskill-decline-${tag}-`));
}

function rec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "skill", source: "o/r", pkg: "o/r@skill", description: "A skill.",
    installs: 10, installsPrior: null, estimated: false, atRepoRoot: false,
    scan: "clean", scanFindings: [], scanAdvisories: [], ...over,
  };
}

function writeIndex(home: string, skills: unknown[]): string {
  const file = path.join(home, "index.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), skillCount: skills.length, repoCount: 1, skills }),
  );
  return file;
}

function readDeclined(home: string): Record<string, { ts: string; until: string; matched?: string }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, ".metaskill", "declined.json"), "utf8"));
  } catch {
    return {};
  }
}

function writeDeclined(home: string, entries: Record<string, { ts: string; until: string; matched?: string }>): void {
  fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
  fs.writeFileSync(path.join(home, ".metaskill", "declined.json"), JSON.stringify(entries));
}

function logRows(home: string): any[] {
  try {
    return fs.readFileSync(path.join(home, ".metaskill", "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Two rows that both match the query strongly; the first outranks the second.
function twoRowIndex(home: string): string {
  return writeIndex(home, [
    rec({ name: "proptech-advisor", source: "borghei/claude-skills", pkg: "borghei/claude-skills@proptech-advisor",
          description: "Proptech content advisor: proptech linkedin content, proptech news for linkedin, proptech content.",
          installs: 300 }),
    rec({ name: "linkedin-content", source: "101-skills/superpowers", pkg: "101-skills/superpowers@linkedin-content",
          description: "Linkedin content writing: linkedin content, proptech news posts for linkedin.",
          installs: 200 }),
  ]);
}

describe("decline command", () => {
  it("records the package with the phrase, logs one row, and asks nothing of the network", async () => {
    const home = freshHome("record");
    const r = await runCli(["decline", "borghei/claude-skills@proptech-advisor", "--matched", "linkedin content proptech news"], home);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`Declined borghei/claude-skills@proptech-advisor for ${DECLINE_DAYS} days — find will not offer it again until then.\n`);
    const d = readDeclined(home)["borghei/claude-skills@proptech-advisor"]!;
    expect(d.matched).toBe("linkedin content proptech news");
    expect(Date.parse(d.until) - Date.parse(d.ts)).toBe(DECLINE_DAYS * 86_400_000);
    const rows = logRows(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: "decline",
      domains: ["decline:borghei/claude-skills@proptech-advisor"],
      installed: [],
      discovered: [{ pkg: "borghei/claude-skills@proptech-advisor", decision: "declined" }],
    });
    expect(fs.existsSync(path.join(home, "stub-calls.log"))).toBe(false);
  });

  it("normalises --matched through the same function install uses", async () => {
    const home = freshHome("norm");
    await runCli(["decline", "o/r@skill", "--matched", "  LinkedIn, CONTENT!! "], home);
    expect(readDeclined(home)["o/r@skill"]!.matched).toBe("linkedin content");
  });

  it("prints usage and exits 2 without a package", async () => {
    const home = freshHome("usage");
    const r = await runCli(["decline"], home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: metaskill decline <owner/repo@skill>");
    expect(readDeclined(home)).toEqual({});
  });
});

describe("find hides a declined package", () => {
  it("the question moves to the next row and the hidden one is named under the list", async () => {
    const home = freshHome("hide");
    const idx = twoRowIndex(home);
    const before = await runCli(["find", "linkedin content proptech news", "--index", idx], home);
    expect(before.stdout).toContain("Ask the user: Install borghei/claude-skills@proptech-advisor ");

    await runCli(["decline", "borghei/claude-skills@proptech-advisor", "--matched", "linkedin content proptech news"], home);
    const after = await runCli(["find", "linkedin content proptech news", "--index", idx], home);
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("Ask the user: Install 101-skills/superpowers@linkedin-content ");
    expect(after.stdout).not.toContain("Ask the user: Install borghei/claude-skills@proptech-advisor ");
    // Not in the rows either: a row on screen with no line about it reads as
    // a candidate.
    expect(after.stdout).not.toMatch(/^ {2}borghei\/claude-skills@proptech-advisor \(/m);
    expect(after.stdout).toMatch(/^Declined earlier, not offered: borghei\/claude-skills@proptech-advisor \(until \d{4}-\d{2}-\d{2}\)$/m);
    // Only the surviving rows are logged as found.
    const last = logRows(home).at(-1);
    expect(last.discovered.map((d: { pkg: string }) => d.pkg)).toEqual(["101-skills/superpowers@linkedin-content"]);
  });

  it("an expired decline hides nothing", async () => {
    const home = freshHome("expired");
    const idx = twoRowIndex(home);
    writeDeclined(home, {
      "borghei/claude-skills@proptech-advisor": { ts: "2026-01-01T00:00:00.000Z", until: "2026-01-31T00:00:00.000Z" },
    });
    const r = await runCli(["find", "linkedin content proptech news", "--index", idx], home);
    expect(r.stdout).toContain("Ask the user: Install borghei/claude-skills@proptech-advisor ");
    expect(r.stdout).not.toContain("Declined earlier");
  });

  it("with every match declined, find says no skills found", async () => {
    const home = freshHome("all-declined");
    const idx = twoRowIndex(home);
    const far = new Date(Date.now() + 86_400_000).toISOString();
    writeDeclined(home, {
      "borghei/claude-skills@proptech-advisor": { ts: far, until: far },
      "101-skills/superpowers@linkedin-content": { ts: far, until: far },
    });
    const r = await runCli(["find", "linkedin content proptech news", "--index", idx], home);
    expect(r.stdout).toContain('[metaskill] No skills found for "linkedin content proptech news"');
    expect(r.stdout).toContain("Declined earlier, not offered: ");
    expect(r.stdout).not.toContain("Ask the user:");
  });
});

describe("find hands the model the decline command too", () => {
  it("under the install line, naming the same package and phrase", async () => {
    const home = freshHome("on-no");
    const idx = twoRowIndex(home);
    const r = await runCli(["find", "linkedin content proptech news", "--index", idx], home);
    const lines = r.stdout.split("\n");
    const yes = lines.findIndex((l) => l.startsWith("Install only on the user's explicit yes: "));
    const no = lines.findIndex((l) => l.startsWith("On no run: "));
    expect(yes).toBeGreaterThanOrEqual(0);
    expect(no).toBe(yes + 1);
    expect(lines[no]).toMatch(
      /^On no run: ".+" ".+" decline borghei\/claude-skills@proptech-advisor --matched "linkedin content proptech news"$/,
    );
  });

  it("prints no decline line where it prints no question", async () => {
    const home = freshHome("no-question");
    const idx = writeIndex(home, [rec({ name: "zorb", pkg: "o/r@zorb", description: "Zorb things.", installs: 10 })]);
    const r = await runCli(["find", "linkedin content proptech news zorb", "--index", idx], home);
    expect(r.stdout).toContain("Weak matches only");
    expect(r.stdout).not.toContain("On no run:");
  });
});

describe("install forgets a decline", () => {
  it("a confirmed install of a declined package removes its entry", async () => {
    const home = freshHome("undo");
    writeIndex(home, [rec({ name: "zorb", pkg: "o/r@zorb", description: "Zorb things.", installs: 10 })]);
    fs.mkdirSync(path.join(home, ".metaskill"), { recursive: true });
    fs.copyFileSync(path.join(home, "index.json"), path.join(home, ".metaskill", "index.json"));
    await runCli(["decline", "o/r@zorb", "--matched", "zorb"], home);
    await runCli(["decline", "o/r@other", "--matched", "other"], home);
    const r = await runCli(["install", "o/r@zorb", "--force", "--matched", "zorb"], home);
    expect(r.code).toBe(0);
    expect(Object.keys(readDeclined(home))).toEqual(["o/r@other"]);
  });
});
