import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, hashPrompt, pruneLog, readLogEntries } from "../src/log.js";
import { defaultPolicy } from "../src/policy.js";
import type { RouteLogEntry } from "../src/types.js";

function entry(ts: string): RouteLogEntry {
  return {
    ts,
    session: "s1",
    prompt_hash: hashPrompt("p"),
    domains: ["xlsx"],
    covered: [],
    discovered: [],
    installed: [],
    latency_ms: 10,
  };
}

describe("log", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-log-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function policyAt(file: string) {
    const p = defaultPolicy();
    p.log.path = path.join(dir, file);
    return p;
  }

  it("hashes prompts as sha256:<hex> and never stores the prompt", () => {
    const h = hashPrompt("secret prompt");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    const p = policyAt("a.jsonl");
    appendLog({ ...entry(new Date().toISOString()), prompt_hash: h }, p);
    const raw = fs.readFileSync(p.log.path, "utf8");
    expect(raw).not.toContain("secret prompt");
    expect(JSON.parse(raw.trim()).prompt_hash).toBe(h);
  });

  it("appends JSONL and reads the last N entries", () => {
    const p = policyAt("b.jsonl");
    for (let i = 0; i < 5; i++) appendLog(entry(`2026-08-2${i}T00:00:00Z`), p);
    expect(readLogEntries(p)).toHaveLength(5);
    expect(readLogEntries(p, 2).map((e) => e.ts)).toEqual(["2026-08-23T00:00:00Z", "2026-08-24T00:00:00Z"]);
  });

  it("prunes entries older than retention_days", () => {
    const p = policyAt("c.jsonl");
    p.log.retentionDays = 90;
    appendLog(entry("2026-01-01T00:00:00Z"), p); // ~8 months old
    appendLog(entry("2026-08-25T00:00:00Z"), p);
    pruneLog(p, new Date("2026-08-26T00:00:00Z"));
    const left = readLogEntries(p);
    expect(left).toHaveLength(1);
    expect(left[0]!.ts).toBe("2026-08-25T00:00:00Z");
  });
});
