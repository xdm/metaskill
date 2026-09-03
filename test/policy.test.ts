import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, defaultPolicy, loadPolicy } from "../src/policy.js";
import type { Candidate, Policy, ScanResult } from "../src/types.js";

function cand(publisher: string, installs: number): Candidate {
  return { pkg: `${publisher}/repo@skill`, publisher, skillName: "skill", installs, url: "" };
}
const clean: ScanResult = { status: "clean", findings: [], advisories: [] };
const dirty: ScanResult = { status: "dirty", findings: ["curl found"], advisories: [] };
const unavailable: ScanResult = { status: "unavailable", findings: [], advisories: [] };
const skipped: ScanResult = { status: "skipped", findings: [], advisories: [] };

// The decision table is exercised with the auto-install knob ON. These tests
// are about which verdict the table computes; the gate that sits over it —
// off by default, so that in a stock install every `auto` below reads
// `ask: auto-install is off; ...` — has its own describe block further down.
// Testing the table through the default policy would collapse six distinct
// rows into the same answer and pin nothing.
function tablePolicy(): Policy {
  const p = defaultPolicy();
  p.trust.autoInstall = true;
  return p;
}

describe("policy.decide (spec 4.5 decision table)", () => {
  const p = tablePolicy(); // allowlist: anthropics, vercel-labs; min_installs 5000

  it("deny_publishers -> deny, even when allowlisted or popular", () => {
    const pol = defaultPolicy();
    pol.trust.denyPublishers = ["anthropics"];
    expect(decide(cand("anthropics", 999999), skipped, pol).decision).toBe("deny");
  });

  // INVERTED. This used to assert "allowlisted publisher -> auto without a
  // scan" and, in doing so, pinned the defect: an allowlisted publisher was
  // auto-installed on the ABSENCE of a verdict. Ruling 4 mutation-tested the
  // allowlist against dirty/estimated/advisories but never against no scan at
  // all, so `metaskill install anthropics/skills@xlsx` installed, unattended,
  // a package the shipped index marks dirty. Spec 4.1: unknown maps to ask,
  // never auto.
  it("allowlisted publisher with no scan -> ask, never auto", () => {
    const v = decide(cand("anthropics", 0), skipped, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("skipped");
  });

  it("allowlisted publisher with an unavailable scan -> ask, naming the status", () => {
    const v = decide(cand("anthropics", 999999), unavailable, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("allowlisted");
    expect(v.reason).toContain("unavailable");
  });

  it("allowlisted publisher with a clean scan -> auto, whatever the install count", () => {
    // The allowlist keeps its one remaining power: it waives the install
    // threshold. Zero installs, clean scan, allowlisted -> auto.
    expect(decide(cand("anthropics", 0), clean, p).decision).toBe("auto");
  });

  it("require_clean_scan: false relaxes the allowlist too, not only the threshold", () => {
    // Deliberate coupling: the switch is the user saying they do not want a
    // clean verdict demanded of anyone. Held only against strangers, it would
    // leave allowlisted publishers treated more strictly than unknown ones.
    const pol = tablePolicy();
    pol.trust.autoThreshold.requireCleanScan = false;
    expect(decide(cand("anthropics", 0), skipped, pol).decision).toBe("auto");
  });

  it("dirty scan -> deny outside the allowlist", () => {
    expect(decide(cand("stranger", 1_000_000), dirty, p).decision).toBe("deny");
  });

  it("clean scan + installs >= threshold -> auto", () => {
    expect(decide(cand("stranger", 5000), clean, p).decision).toBe("auto");
  });

  // A pattern found in a skill's prose is the documented shape of the most
  // common malicious-skill technique, and also the shape of ordinary
  // documentation. It must not deny, and it must not pass silently.
  it("clean scan with advisories -> ask, however popular the skill", () => {
    const withAdvisory: ScanResult = { status: "clean", findings: [], advisories: ['"curl " found in SKILL.md'] };
    const v = decide(cand("stranger", 1_000_000), withAdvisory, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("curl ");
  });

  it("clean scan with no advisories and enough installs -> auto", () => {
    const noAdvisory: ScanResult = { status: "clean", findings: [], advisories: [] };
    expect(decide(cand("stranger", 1_000_000), noAdvisory, p).decision).toBe("auto");
  });

  it("clean scan below threshold -> ask", () => {
    expect(decide(cand("stranger", 4999), clean, p).decision).toBe("ask");
  });

  it("scan unavailable -> never auto, even above threshold", () => {
    expect(decide(cand("stranger", 1_000_000), unavailable, p).decision).toBe("ask");
  });

  it("require_clean_scan: false lets threshold alone auto-install", () => {
    const pol = tablePolicy();
    pol.trust.autoThreshold.requireCleanScan = false;
    expect(decide(cand("stranger", 5000), unavailable, pol).decision).toBe("auto");
  });

  it("denies a skill listed in deny_skills", () => {
    const p = defaultPolicy();
    p.trust.denySkills = ["anthropics/skills@xlsx"];
    const c = { pkg: "anthropics/skills@xlsx", publisher: "anthropics", skillName: "xlsx", installs: 500000, url: "" };
    expect(decide(c, { status: "clean", findings: [], advisories: [] }, p).decision).toBe("deny");
  });

  it("asks about an estimated skill however high its sibling prior", () => {
    const p = defaultPolicy();
    const c = { pkg: "someone/repo@thing", publisher: "someone", skillName: "thing", installs: 999999, url: "", estimated: true };
    const v = decide(c, { status: "clean", findings: [], advisories: [] }, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/no real install count/);
  });

  it("asks about an estimated skill even from an allowlisted publisher", () => {
    const p = defaultPolicy();
    const c = {
      pkg: "anthropics/skills@guess",
      publisher: "anthropics",
      skillName: "guess",
      installs: 999999,
      url: "",
      estimated: true,
    };
    const v = decide(c, { status: "clean", findings: [], advisories: [] }, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/no real install count/);
  });

  it("does not let the allowlist waive a dirty scan", () => {
    const p = defaultPolicy();
    const c = { pkg: "anthropics/skills@xlsx", publisher: "anthropics", skillName: "xlsx", installs: 500000, url: "" };
    const v = decide(c, { status: "dirty", findings: ["os.environ in scripts/run.py"], advisories: [] }, p);
    expect(v.decision).toBe("deny");
  });

  it("asks about an allowlisted publisher's skill when the scan carries advisories", () => {
    const p = defaultPolicy();
    const c = { pkg: "anthropics/skills@sketchy", publisher: "anthropics", skillName: "sketchy", installs: 999999, url: "" };
    const v = decide(c, { status: "clean", findings: [], advisories: ['"curl " found in SKILL.md'] }, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toContain("curl ");
  });

  it("still auto-installs an allowlisted publisher with a clean scan below the threshold", () => {
    const p = tablePolicy();
    const c = { pkg: "anthropics/skills@tiny", publisher: "anthropics", skillName: "tiny", installs: 12, url: "" };
    expect(decide(c, { status: "clean", findings: [], advisories: [] }, p).decision).toBe("auto");
  });
});

// The gate over the table. `find` ranks and the model picks; `install`
// enforces policy — and until that loop is proven in real use, the one thing
// nothing may do is install unattended. Every `auto` the table can produce
// leaves decide() through this one check, so a row added to the table later
// is covered without anyone remembering to cover it.
describe("policy.decide: the trust.auto_install gate", () => {
  it("downgrades auto to ask while trust.auto_install is off (the default)", () => {
    const p = defaultPolicy();
    expect(p.trust.autoInstall).toBe(false);
    const v = decide(cand("anthropics", 500000), clean, p);
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/auto-install is off/);
    // The computed verdict is carried through, not thrown away: the reason a
    // human reads still says why the package WOULD have qualified.
    expect(v.reason).toContain("allowlisted");
  });

  it("downgrades the threshold row too, not only the allowlist row", () => {
    // Two different `auto` returns in the table; one gate. A fix applied per
    // branch is the shape this test exists to rule out.
    const v = decide(cand("stranger", 500000), clean, defaultPolicy());
    expect(v.decision).toBe("ask");
    expect(v.reason).toMatch(/auto-install is off/);
    expect(v.reason).toContain("installs >= 5000");
  });

  it("returns auto for a trusted clean match once auto_install is on", () => {
    const p = defaultPolicy();
    p.trust.autoInstall = true;
    expect(decide(cand("anthropics", 500000), clean, p).decision).toBe("auto");
  });

  it("never turns a deny into ask, whatever auto_install says", () => {
    // The knob only ever lowers what may happen unattended.
    const p = defaultPolicy();
    p.trust.autoInstall = true;
    expect(decide(cand("anthropics", 500000), dirty, p).decision).toBe("deny");
    p.trust.autoInstall = false;
    expect(decide(cand("anthropics", 500000), dirty, p).decision).toBe("deny");
  });

  it("leaves an ask the table already produced exactly as it was", () => {
    const v = decide(cand("stranger", 10), clean, defaultPolicy());
    expect(v.decision).toBe("ask");
    expect(v.reason).not.toMatch(/auto-install is off/);
    // ...bar the four words every ask now opens with; see the describe below.
    expect(v.reason).toContain("publisher stranger not allowlisted");
  });
});

// First real v2 use: `find "linkedin post copywriting"` printed five ask rows
// with a plainly fitting top row and the model asked nothing. One of the three
// causes was this string. `[ask: publisher kostja94 not allowlisted]` states a
// fact ABOUT THE PACKAGE, and a reader looking for what to do next reads it as
// a verdict against it — the row was scored, found wanting, move on. `ask` is
// not a finding, it is an instruction to the reader: the reason opens with the
// action and lets the fact it rests on follow.
describe("policy.decide: every ask reason opens with the action", () => {
  const p = tablePolicy();
  const advisory: ScanResult = { status: "clean", findings: [], advisories: ['"curl " found in SKILL.md'] };
  const estimated: Candidate = { ...cand("someone", 999999), estimated: true };

  // One case per `ask` branch of the table, plus the gate's downgrade. A
  // branch added later that forgets the prefix has to get past the single
  // exit in decide(), which is the point of prefixing there and not per row.
  const asks: Array<[string, ReturnType<typeof decide>]> = [
    ["not allowlisted", decide(cand("stranger", 10), clean, p)],
    ["below threshold with no scan", decide(cand("stranger", 10), skipped, p)],
    ["scan unavailable above threshold", decide(cand("stranger", 1_000_000), unavailable, p)],
    ["estimated installs", decide(estimated, clean, p)],
    ["scan advisory", decide(cand("anthropics", 999999), advisory, p)],
    ["allowlisted but unscanned", decide(cand("anthropics", 0), skipped, p)],
    ["auto-install off (the default)", decide(cand("anthropics", 500000), clean, defaultPolicy())],
  ];

  for (const [label, v] of asks) {
    it(`reads as an instruction: ${label}`, () => {
      expect(v.decision).toBe("ask");
      expect(v.reason.startsWith("needs your yes — "), `reason was: ${v.reason}`).toBe(true);
      // The fact survives the prefix; it is not replaced by it.
      expect(v.reason.length).toBeGreaterThan("needs your yes — ".length);
    });
  }

  it("says it once, not twice, when the knob downgrades an auto", () => {
    // The downgrade wraps a computed verdict's reason. Prefixing before that
    // wrap, or at both exits, would produce `needs your yes — auto-install is
    // off; needs your yes — ...`.
    const v = decide(cand("anthropics", 500000), clean, defaultPolicy());
    expect(v.reason).toBe("needs your yes — auto-install is off; publisher anthropics is allowlisted, scan clean");
  });

  it("leaves deny alone — nothing about a denied package needs the user's yes", () => {
    // A `deny` wearing "needs your yes" would invite exactly the question
    // that no flag can act on.
    const v = decide(cand("anthropics", 500000), dirty, p);
    expect(v.decision).toBe("deny");
    expect(v.reason).not.toContain("needs your yes");
  });
});

describe("policy.loadPolicy", () => {
  let home: string;
  const saved = process.env.METASKILL_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-pol-"));
    process.env.METASKILL_HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.METASKILL_HOME;
    else process.env.METASKILL_HOME = saved;
  });

  it("returns defaults when no policy file exists", () => {
    const p = loadPolicy();
    expect(p.trust.allowlist).toContain("anthropics");
  });

  it("parses the shipped template shape (snake_case)", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      [
        "version: 1",
        "trust:",
        "  allowlist: [me]",
        "  auto_threshold:",
        "    min_installs: 100",
        "    require_clean_scan: false",
        "  deny_publishers: [evil]",
        "scan:",
        "  deny_if_contains: ['rm -rf']",
        "  max_archive_kb: 64",
        "log:",
        "  path: ~/custom/log.jsonl",
        "  retention_days: 7",
      ].join("\n"),
    );
    const p = loadPolicy();
    expect(p.trust.allowlist).toEqual(["me"]);
    expect(p.trust.autoThreshold).toEqual({ minInstalls: 100, requireCleanScan: false });
    expect(p.trust.denyPublishers).toEqual(["evil"]);
    expect(p.scan.denyIfContains).toEqual(["rm -rf"]);
    expect(p.scan.maxArchiveKb).toBe(64);
    expect(p.log.path).toBe(path.join(os.homedir(), "custom/log.jsonl"));
    expect(p.log.retentionDays).toBe(7);
  });

  it("reads trust.auto_install from the yaml", () => {
    fs.writeFileSync(path.join(home, "metaskill.yaml"), ["version: 1", "trust:", "  auto_install: true"].join("\n"));
    expect(loadPolicy().trust.autoInstall).toBe(true);
  });

  it("defaults auto_install off when the yaml is silent about it", () => {
    fs.writeFileSync(path.join(home, "metaskill.yaml"), ["version: 1", "trust:", "  allowlist: [me]"].join("\n"));
    expect(loadPolicy().trust.autoInstall).toBe(false);
  });

  it("reads deny_skills from the yaml", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      ["version: 1", "trust:", "  deny_skills: [bad/repo@thing]"].join("\n"),
    );
    expect(loadPolicy().trust.denySkills).toEqual(["bad/repo@thing"]);
  });

  it("loads a v1 config carrying every retired section", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      [
        "version: 1",
        "classifier:",
        "  llm: always",
        "  model: claude-haiku-4-5",
        "  trivial_max_chars: 25",
        "domains:",
        "  crm: someone/skills@crm-rest",
        "custom_domains:",
        "  - id: wordpress",
        "    keywords: [wordpress]",
        "    query: wordpress",
        "trust:",
        "  allowlist: [me]",
      ].join("\n"),
    );
    const p = loadPolicy();
    expect(p.trust.allowlist).toEqual(["me"]);
    expect(p).not.toHaveProperty("classifier");
    expect(p).not.toHaveProperty("domains");
  });

  it("falls back to defaults on broken yaml", () => {
    fs.writeFileSync(path.join(home, "metaskill.yaml"), "trust: [unclosed");
    expect(loadPolicy().trust.allowlist).toContain("anthropics");
  });

  it("the shipped template parses and allowlists the default publishers", () => {
    fs.copyFileSync(path.resolve("templates/metaskill.yaml"), path.join(home, "metaskill.yaml"));
    const p = loadPolicy();
    expect(p.trust.allowlist).toEqual(["anthropics", "vercel-labs"]);
    expect(p.trust.autoThreshold).toEqual({ minInstalls: 5000, requireCleanScan: true });
    // The shipped default is the safe one: a fresh install installs nothing
    // unattended until the user opts in.
    expect(p.trust.autoInstall).toBe(false);
    expect(p.scan.denyIfContains).toContain("hooks/");
  });
});
