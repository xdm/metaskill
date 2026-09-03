import { describe, expect, it } from "vitest";
import { parseFrontmatter, singleLine } from "../src/frontmatter.js";

// Frontmatter fixtures are written line by line so that blank lines — which
// carry meaning inside a block scalar — are visible in the test itself.
function md(...lines: string[]): string {
  return ["---", ...lines, "---", "", "Body text.", ""].join("\n");
}

describe("parseFrontmatter: plain scalars", () => {
  it("keeps unquoted colons and braces, the reason this parser is not strict YAML", () => {
    const fm = parseFrontmatter(md("name: broken", "description: Use this: with a colon, {braces} and: more"));
    expect(fm.name).toBe("broken");
    expect(fm.description).toBe("Use this: with a colon, {braces} and: more");
  });

  it("strips surrounding quotes, leaves missing fields undefined and empty values empty", () => {
    const fm = parseFrontmatter(md('name: "quoted"', "description:"));
    expect(fm.name).toBe("quoted");
    expect(fm.description).toBe("");
    expect(fm.license).toBeUndefined();
  });

  it("returns nothing when the file does not open with ---, and stops at the closing ---", () => {
    expect(parseFrontmatter("name: nope\n")).toEqual({});
    expect(parseFrontmatter(md("name: a")).license).toBeUndefined();
    expect(parseFrontmatter("---\nname: a\n---\nlicense: MIT\n").license).toBeUndefined();
  });
});

describe("parseFrontmatter: block scalars", () => {
  it("| keeps the line breaks and clips to one trailing newline", () => {
    const fm = parseFrontmatter(md("name: demo", "description: |", "  Line one.", "  Line two."));
    expect(fm.description).toBe("Line one.\nLine two.\n");
  });

  it("> folds the lines into single spaces", () => {
    const fm = parseFrontmatter(md("description: >", "  Line one", "  continues here."));
    expect(fm.description).toBe("Line one continues here.\n");
  });

  it("> turns a blank line into one newline and keeps folding after it", () => {
    const fm = parseFrontmatter(
      md("description: >", "  First paragraph.", "", "  Second one", "  wraps.", "", "", "  Third."),
    );
    expect(fm.description).toBe("First paragraph.\nSecond one wraps.\n\nThird.\n");
  });

  it("- strips the trailing newline (>- and |-)", () => {
    expect(parseFrontmatter(md("description: >-", "  One", "  two.")).description).toBe("One two.");
    expect(parseFrontmatter(md("description: |-", "  One", "  two.")).description).toBe("One\ntwo.");
  });

  it("+ keeps every trailing newline (|+ and >+)", () => {
    expect(parseFrontmatter(md("description: |+", "  Kept.", "", "")).description).toBe("Kept.\n\n\n");
    expect(parseFrontmatter(md("description: >+", "  Kept.", "")).description).toBe("Kept.\n\n");
  });

  it("leaves the key undefined when the marker has nothing under it — never the marker itself", () => {
    for (const marker of ["|", ">", ">-", "|-", "|+", ">+"]) {
      const empty = parseFrontmatter(md("name: demo", `description: ${marker}`));
      expect(empty.description, `${marker} with no body`).toBeUndefined();
      const blanks = parseFrontmatter(md("name: demo", `description: ${marker}`, "", "   ", ""));
      expect(blanks.description, `${marker} over blank lines`).toBeUndefined();
      expect(blanks.name).toBe("demo");
    }
  });

  it("recognises a marker followed by trailing whitespace", () => {
    expect(parseFrontmatter(md("description: |   ", "  Body.")).description).toBe("Body.\n");
    expect(parseFrontmatter(md("description: >-\t", "  Body.")).description).toBe("Body.");
  });

  it("keeps unquoted colons inside a block and does not read the block's lines as keys", () => {
    const fm = parseFrontmatter(
      md("name: demo", "description: |", "  Use when: exporting data.", "  license: not-a-key"),
    );
    expect(fm.description).toBe("Use when: exporting data.\nlicense: not-a-key\n");
    expect(fm.license).toBeUndefined();
  });

  it("strips the common indentation and keeps what is indented deeper", () => {
    const fm = parseFrontmatter(md("description: |", "    Outer.", "      Inner.", "    Outer again."));
    expect(fm.description).toBe("Outer.\n  Inner.\nOuter again.\n");
  });

  it("does not strip quotes inside a block — there they are content", () => {
    expect(parseFrontmatter(md("description: |", '  "quoted"')).description).toBe('"quoted"\n');
  });

  it("applies to every key, not just description", () => {
    const fm = parseFrontmatter(md("name: >-", "  folded-name", "license: |-", "  MIT", "version: 1.2.3"));
    expect(fm.name).toBe("folded-name");
    expect(fm.license).toBe("MIT");
    expect(fm.version).toBe("1.2.3");
  });

  it("ends the block at the closing --- and at the next key, and keeps reading after it", () => {
    const fm = parseFrontmatter(md("description: |", "  Body.", "license: MIT", "version: 2"));
    expect(fm.description).toBe("Body.\n");
    expect(fm.license).toBe("MIT");
    expect(fm.version).toBe("2");
    const last = parseFrontmatter(md("name: demo", "description: |", "  Body."));
    expect(last.description).toBe("Body.\n");
    expect(last.name).toBe("demo");
  });
});

// The parser is faithful, so a block scalar can now hand a caller a value with
// a newline in it — impossible before. Callers that print into one line or a
// fixed-width table collapse it here, at the boundary, never in the parser.
describe("singleLine", () => {
  it("collapses every whitespace run to one space and trims", () => {
    expect(singleLine("1.2.3\n(build 456)\n")).toBe("1.2.3 (build 456)");
    expect(singleLine("  a \t\n  b  ")).toBe("a b");
    expect(singleLine("already-one-line")).toBe("already-one-line");
  });

  it("returns undefined for nothing at all, so the caller's missing-value path runs", () => {
    expect(singleLine(undefined)).toBeUndefined();
    expect(singleLine("")).toBeUndefined();
    expect(singleLine("  \n\t ")).toBeUndefined();
  });

  it("is what a multi-line frontmatter version becomes on its way to the lock", () => {
    const fm = parseFrontmatter(md("name: demo", "version: |", "  1.2.3", "  (build 456)"));
    expect(fm.version).toBe("1.2.3\n(build 456)\n"); // the file's own shape, kept
    expect(singleLine(fm.version)).toBe("1.2.3 (build 456)"); // what a lock entry may hold
  });
});
