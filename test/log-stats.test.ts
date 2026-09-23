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
    expect(s).toEqual({ prompts: 3, finds: 1, pct: 33, installs: 0, declines: 0 });
  });

  // CORRECTION: legacy v1 handoff rows ("search" from the old `route
  // --search`, "manual" from `route --domains`) are model-driven lookups
  // too — they are the rows behind the measured 3% baseline. Counting them
  // as prompts instead of finds would undercount that baseline and flatter
  // any after-measurement, so they must land in
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
    expect(s).toEqual({ prompts: 4, finds: 3, pct: 75, installs: 0, declines: 0 });
  });

  it("reports zero rather than dividing by zero on an empty log", () => {
    expect(followThrough([])).toEqual({ prompts: 0, finds: 0, pct: 0, installs: 0, declines: 0 });
  });

  it("caps the percentage at 100 when finds outnumber prompts", () => {
    // A single prompt can carry several tasks, and the protocol asks for a
    // find per task — so finds > prompts is ordinary, while
    // "follow-through=300%" reads as a broken counter.
    const s = followThrough([e("a"), e("find"), e("find"), e("find")]);
    expect(s).toEqual({ prompts: 1, finds: 3, pct: 100, installs: 0, declines: 0 });
  });

  // "install" rows are `install`'s own bookkeeping (one per successful
  // install), not a routed prompt or a lookup that followed one — counting
  // them either way would move the ratio on data that was never a prompt.
  // `log --stats` on a log with install rows must read identically to the
  // same log without them.
  it("counts install rows as neither a prompt nor a find", () => {
    const withInstalls = followThrough([
      e("a"),
      e("b"),
      e("find", ["find:excel"]),
      e("install", ["install:o/r@skill"]),
      e("c"),
    ]);
    const without = followThrough([e("a"), e("b"), e("find", ["find:excel"]), e("c")]);
    const { installs: _i, ...ratioWith } = withInstalls;
    const { installs: _j, ...ratioWithout } = without;
    expect(ratioWith).toEqual(ratioWithout);
    expect(withInstalls).toEqual({ prompts: 3, finds: 1, pct: 33, installs: 1, declines: 0 });
  });
});

describe("answered questions", () => {
  // The log knows a find happened and an install happened; until `decline`
  // it could not tell "the user said no" from "the model never asked". The
  // sum of installs and declines is the number of questions that reached a
  // user and got an answer — the middle of the funnel follow-through alone
  // cannot see.
  it("counts install and decline rows as answered questions, and neither as a prompt or a find", () => {
    const s = followThrough([
      e("a"),
      e("find", ["find:excel"]),
      e("install", ["install:o/r@x"]),
      e("decline", ["decline:o/r@y"]),
      e("decline", ["decline:o/r@z"]),
      e("b"),
    ]);
    expect(s).toEqual({ prompts: 2, finds: 1, pct: 50, installs: 1, declines: 2 });
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

  it("prints the answered-question counts on their own line", () => {
    const out = capture([e("a"), e("find"), e("install", ["install:o/r@x"]), e("decline", ["decline:o/r@y"])]);
    expect(out).toContain("answered questions=2  (installs=1 declines=1)");
  });
});
