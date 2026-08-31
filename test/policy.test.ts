import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, defaultPolicy, loadPolicy } from "../src/policy.js";
import type { Candidate, ScanResult } from "../src/types.js";

function cand(publisher: string, installs: number): Candidate {
  return { pkg: `${publisher}/repo@skill`, publisher, skillName: "skill", installs, url: "" };
}
const clean: ScanResult = { status: "clean", findings: [], advisories: [] };
const dirty: ScanResult = { status: "dirty", findings: ["curl found"], advisories: [] };
const unavailable: ScanResult = { status: "unavailable", findings: [], advisories: [] };
const skipped: ScanResult = { status: "skipped", findings: [], advisories: [] };

describe("policy.decide (spec 4.5 decision table)", () => {
  const p = defaultPolicy(); // allowlist: anthropics, vercel-labs; min_installs 5000

  it("deny_publishers -> deny, even when allowlisted or popular", () => {
    const pol = defaultPolicy();
    pol.trust.denyPublishers = ["anthropics"];
    expect(decide(cand("anthropics", 999999), skipped, pol).decision).toBe("deny");
  });

  it("allowlisted publisher -> auto without a scan", () => {
    expect(decide(cand("anthropics", 0), skipped, p).decision).toBe("auto");
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
    const pol = defaultPolicy();
    pol.trust.autoThreshold.requireCleanScan = false;
    expect(decide(cand("stranger", 5000), unavailable, pol).decision).toBe("auto");
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
    expect(p.classifier.trivialMaxChars).toBe(40);
  });

  it("parses the shipped template shape (snake_case)", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      [
        "version: 1",
        "classifier:",
        "  trivial_max_chars: 25",
        "trust:",
        "  allowlist: [me]",
        "  auto_threshold:",
        "    min_installs: 100",
        "    require_clean_scan: false",
        "  deny_publishers: [evil]",
        "scan:",
        "  deny_if_contains: ['rm -rf']",
        "  max_archive_kb: 64",
        "domains:",
        "  scraping: me/skills@crawler",
        "log:",
        "  path: ~/custom/log.jsonl",
        "  retention_days: 7",
      ].join("\n"),
    );
    const p = loadPolicy();
    expect(p.classifier.trivialMaxChars).toBe(25);
    expect(p.trust.allowlist).toEqual(["me"]);
    expect(p.trust.autoThreshold).toEqual({ minInstalls: 100, requireCleanScan: false });
    expect(p.trust.denyPublishers).toEqual(["evil"]);
    expect(p.scan.denyIfContains).toEqual(["rm -rf"]);
    expect(p.scan.maxArchiveKb).toBe(64);
    expect(p.domains.scraping).toBe("me/skills@crawler");
    expect(p.log.path).toBe(path.join(os.homedir(), "custom/log.jsonl"));
    expect(p.log.retentionDays).toBe(7);
  });

  it("ignores the retired classifier.llm/model keys from older configs", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      [
        "version: 1",
        "classifier:",
        "  llm: always",
        "  model: claude-haiku-4-5",
        "  trivial_max_chars: 25",
      ].join("\n"),
    );
    const p = loadPolicy();
    expect(p.classifier).toEqual({ trivialMaxChars: 25 });
  });

  it("parses custom_domains and drops malformed entries", () => {
    fs.writeFileSync(
      path.join(home, "metaskill.yaml"),
      [
        "custom_domains:",
        "  - id: wordpress",
        "    keywords: [wordpress, woocommerce]",
        "    query: wordpress",
        "  - id: 'BAD ID!'", // invalid id -> dropped
        "    keywords: [x]",
        "  - id: notion", // query defaults to the id
      ].join("\n"),
    );
    const p = loadPolicy();
    expect(p.customDomains).toEqual([
      { id: "wordpress", keywords: ["wordpress", "woocommerce"], extensions: [], query: "wordpress" },
      { id: "notion", keywords: [], extensions: [], query: "notion" },
    ]);
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
    expect(p.scan.denyIfContains).toContain("hooks/");
    expect(p.domains).toEqual({});
  });
});
