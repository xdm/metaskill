import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { followThrough, logCommand } from "../src/commands/log.js";
import type { RouteLogEntry } from "../src/types.js";

function e(session: string, domains: string[] = []): RouteLogEntry {
  return { ts: "2026-08-31T00:00:00.000Z", session, prompt_hash: "sha256:x", domains,
           covered: [], discovered: [], installed: [], latency_ms: 1 };
}

describe("followThrough", () => {
  it("is the share of prompts that produced a find call", () => {
    const s = followThrough([e("a"), e("b"), e("find", ["find:excel"]), e("c")]);
    expect(s).toEqual({ prompts: 3, finds: 1, pct: 33 });
  });

  // CORRECTION: legacy v1 handoff rows ("search" from the old `route
  // --search`, "manual" from `route --domains`) are model-driven lookups
  // too — they are the 8 rows that produced the measured 2026-08-31 baseline
  // (3%). Counting them as prompts instead of finds would undercount that
  // baseline and flatter any after-measurement, so they must land in
  // `finds` alongside "find".
  it("counts legacy v1 handoff rows (search, manual) as finds, not prompts", () => {
    const s = followThrough([
      e("a"),
      e("b"),
      e("find", ["find:excel"]),
      e("search", ["search:excel"]),
      e("manual", ["excel"]),
      e("c"),
      e("d"),
    ]);
    expect(s).toEqual({ prompts: 4, finds: 3, pct: 75 });
  });

  it("reports zero rather than dividing by zero on an empty log", () => {
    expect(followThrough([])).toEqual({ prompts: 0, finds: 0, pct: 0 });
  });

  it("caps the percentage at 100 when finds outnumber prompts", () => {
    // A single prompt can carry several tasks, and the protocol asks for a
    // find per task — so finds > prompts is ordinary, while
    // "follow-through=300%" reads as a broken counter.
    const s = followThrough([e("a"), e("find"), e("find"), e("find")]);
    expect(s).toEqual({ prompts: 1, finds: 3, pct: 100 });
  });
});

describe("log --stats output", () => {
  function capture(entries: RouteLogEntry[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-stats-"));
    const log = path.join(dir, "log.jsonl");
    fs.writeFileSync(log, entries.map((x) => JSON.stringify(x)).join("\n") + (entries.length ? "\n" : ""));
    const prevHome = process.env.METASKILL_HOME;
    process.env.METASKILL_HOME = dir; // policy.log.path defaults under it
    const write = process.stdout.write.bind(process.stdout);
    let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      logCommand(10, { stats: true });
    } finally {
      process.stdout.write = write;
      if (prevHome === undefined) delete process.env.METASKILL_HOME;
      else process.env.METASKILL_HOME = prevHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return out;
  }

  it("says there is no ratio yet instead of printing 0% for prompts=0", () => {
    // prompts=0 finds=1 printed "follow-through=0%", which states the
    // opposite of what the log holds: a lookup ran, and nothing it could
    // have followed did.
    const out = capture([e("find", ["find:excel"])]);
    expect(out).toContain("prompts=0 finds=1");
    expect(out).toContain("no prompts logged yet");
    expect(out).not.toContain("0%");
  });

  it("prints the raw counts and a note when finds outnumber prompts", () => {
    const out = capture([e("a"), e("find"), e("find"), e("find")]);
    expect(out).toContain("prompts=1 finds=3");
    expect(out).toContain("follow-through=100%");
    expect(out).toContain("more finds than prompts");
  });
});
