import { describe, expect, it } from "vitest";
import { followThrough } from "../src/commands/log.js";
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
});
