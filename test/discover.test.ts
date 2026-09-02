import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverByQuery, parseFindOutput, parseInstalls, publisherOf, stripAnsi } from "../src/discover.js";

// Captured from real `npx skills find xlsx` (v1.5.23), colors included.
const REAL_OUTPUT = [
  "",
  "\x1b[38;5;102mInstall with\x1b[0m npx skills add <owner/repo@skill>",
  "",
  "\x1b[38;5;145manthropics/skills@xlsx\x1b[0m \x1b[36m158.3K installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/anthropics/skills/xlsx\x1b[0m",
  "",
  "\x1b[38;5;145mmodelscope.cn@minimax-xlsx\x1b[0m \x1b[36m1.1K installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/modelscope.cn/minimax-xlsx\x1b[0m",
  "",
  "\x1b[38;5;145msmithery.ai@xlsx\x1b[0m \x1b[36m956 installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/smithery.ai/xlsx\x1b[0m",
].join("\n");

describe("parseInstalls", () => {
  it("handles K/M suffixes and plain numbers", () => {
    expect(parseInstalls("158.3K")).toBe(158300);
    expect(parseInstalls("1.1K")).toBe(1100);
    expect(parseInstalls("2M")).toBe(2000000);
    expect(parseInstalls("956")).toBe(956);
    expect(parseInstalls("garbage")).toBe(0);
  });
});

describe("parseFindOutput", () => {
  it("parses real skills find output (ANSI, github and registry publishers)", () => {
    const c = parseFindOutput(REAL_OUTPUT);
    expect(c).toHaveLength(3);
    expect(c[0]).toEqual({
      pkg: "anthropics/skills@xlsx",
      publisher: "anthropics",
      skillName: "xlsx",
      installs: 158300,
      url: "https://skills.sh/anthropics/skills/xlsx",
    });
    expect(c[1]!.publisher).toBe("modelscope.cn");
    expect(c[1]!.skillName).toBe("minimax-xlsx");
    expect(c[2]!.installs).toBe(956);
  });

  it("ignores the install-hint header line", () => {
    expect(parseFindOutput(REAL_OUTPUT).some((c) => c.pkg.includes("<owner"))).toBe(false);
  });

  it("stripAnsi and publisherOf helpers", () => {
    expect(stripAnsi("\x1b[36mhi\x1b[0m")).toBe("hi");
    expect(publisherOf("a/b@c")).toBe("a");
    expect(publisherOf("host.tld@c")).toBe("host.tld");
  });
});

describe("discover cache (24h, spec 4.2.4)", () => {
  let home: string;
  const saved = process.env.METASKILL_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-disc-"));
    process.env.METASKILL_HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.METASKILL_HOME;
    else process.env.METASKILL_HOME = saved;
  });

  it("runs the CLI once, then serves from cache within 24h", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      return { stdout: REAL_OUTPUT };
    };
    const first = await discoverByQuery("xlsx", { runner, now: new Date("2026-08-26T10:00:00Z") });
    expect(first).toHaveLength(3);
    const second = await discoverByQuery("xlsx", { runner, now: new Date("2026-08-26T20:00:00Z") });
    expect(second).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it("re-runs after the TTL and falls back to stale cache on failure", async () => {
    let calls = 0;
    const runner = async () => {
      calls++;
      if (calls === 2) throw new Error("network down");
      return { stdout: REAL_OUTPUT };
    };
    await discoverByQuery("xlsx", { runner, now: new Date("2026-08-26T10:00:00Z") });
    const stale = await discoverByQuery("xlsx", { runner, now: new Date("2026-08-28T10:00:00Z") });
    expect(calls).toBe(2);
    expect(stale).toHaveLength(3); // stale cache served despite the failure
  });
});
