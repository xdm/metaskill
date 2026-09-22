import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeDeclines, addDecline, DECLINE_DAYS, declinesPath, readDeclines, removeDecline } from "../src/declines.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-declines-"));
  process.env.METASKILL_HOME = path.join(home, ".metaskill");
});
afterEach(() => {
  delete process.env.METASKILL_HOME;
});

describe("declines store", () => {
  it("lives in its own file under the metaskill home", () => {
    expect(declinesPath()).toBe(path.join(home, ".metaskill", "declined.json"));
  });

  it("records a decline with the phrase that led to it and an expiry DECLINE_DAYS out", () => {
    const now = new Date("2026-09-22T10:00:00.000Z");
    addDecline("o/r@skill", "linkedin content", now);
    const d = readDeclines()["o/r@skill"]!;
    expect(d.matched).toBe("linkedin content");
    expect(d.ts).toBe(now.toISOString());
    expect(Date.parse(d.until) - now.getTime()).toBe(DECLINE_DAYS * 24 * 60 * 60 * 1000);
  });

  it("a repeat decline extends the expiry rather than adding a row", () => {
    addDecline("o/r@skill", "a", new Date("2026-09-01T00:00:00.000Z"));
    addDecline("o/r@skill", "b", new Date("2026-09-22T00:00:00.000Z"));
    const all = readDeclines();
    expect(Object.keys(all)).toEqual(["o/r@skill"]);
    expect(all["o/r@skill"]!.until).toBe(new Date(Date.parse("2026-09-22T00:00:00.000Z") + DECLINE_DAYS * 86_400_000).toISOString());
  });

  it("activeDeclines drops expired entries and keeps live ones", () => {
    addDecline("o/r@old", "x", new Date("2026-01-01T00:00:00.000Z"));
    addDecline("o/r@fresh", "y", new Date("2026-09-20T00:00:00.000Z"));
    const live = activeDeclines(new Date("2026-09-22T00:00:00.000Z"));
    expect(Object.keys(live)).toEqual(["o/r@fresh"]);
  });

  it("removeDecline forgets one package and leaves the rest", () => {
    addDecline("o/r@a", "x");
    addDecline("o/r@b", "y");
    removeDecline("o/r@a");
    expect(Object.keys(readDeclines())).toEqual(["o/r@b"]);
  });

  it("a missing or corrupt file reads as no declines", () => {
    expect(readDeclines()).toEqual({});
    fs.mkdirSync(path.dirname(declinesPath()), { recursive: true });
    fs.writeFileSync(declinesPath(), "{not json");
    expect(readDeclines()).toEqual({});
    expect(activeDeclines()).toEqual({});
  });
});
