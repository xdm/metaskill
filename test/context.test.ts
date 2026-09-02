import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context.js";
import type { Candidate } from "../src/types.js";

const cand = (pkg: string, installs: number): Candidate => ({
  pkg,
  publisher: pkg.split("/")[0]!,
  skillName: pkg.slice(pkg.lastIndexOf("@") + 1),
  installs,
  url: "",
});

describe("buildContext (spec 4.2.7)", () => {
  it("renders the full block", () => {
    const ctx = buildContext({
      installedNow: [{ pkg: "anthropics/skills@xlsx", version: "2026.07.1", path: "/Users/x/.claude/skills/xlsx/SKILL.md" }],
      present: [{ domain: "python", skill: "python-best-practices" }],
      ask: [{ candidate: cand("foo/bar@xlsx-charts", 410), reason: "publisher foo not allowlisted" }],
      denied: 1,
    });
    expect(ctx).toContain("Installed now: anthropics/skills@xlsx (v2026.07.1) →");
    expect(ctx).toContain("skills/xlsx/SKILL.md");
    expect(ctx).toContain("Already present: python-best-practices");
    expect(ctx).toContain("Needs confirmation: foo/bar@xlsx-charts (410 installs, publisher foo not allowlisted)");
    expect(ctx).toContain("ask the user one question");
    expect(ctx).toContain("Skipped by policy: 1");
  });

  it("returns null when there is nothing actionable (spec 4.8: report nothing)", () => {
    expect(buildContext({ installedNow: [], present: [], ask: [], denied: 0 })).toBeNull();
  });

  it("caps at 600 chars with whole-line truncation, keeping installs first", () => {
    const report = {
      installedNow: [{ pkg: "anthropics/skills@xlsx", version: "1", path: "/p/SKILL.md" }],
      present: [] as { domain: string; skill: string }[],
      ask: Array.from({ length: 20 }, (_, i) => ({
        candidate: cand(`pub${i}/repo@skill-with-a-rather-long-name-${i}`, 100 + i),
        reason: "publisher not allowlisted, and this reason line is deliberately padded out",
      })),
      denied: 0,
    };
    const ctx = buildContext(report)!;
    expect(ctx.length).toBeLessThanOrEqual(600);
    expect(ctx).toContain("Installed now:");
    for (const line of ctx.split("\n")) expect(line.endsWith("…")).toBe(false); // no cut lines
  });
});
