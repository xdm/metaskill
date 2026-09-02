import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshIndex } from "../src/index/refresh.js";

const body = JSON.stringify({ schemaVersion: 1, builtAt: "2026-08-31T00:00:00.000Z", skillCount: 1, repoCount: 1,
  skills: [{ name: "a", source: "o/r", pkg: "o/r@a", description: "d", installs: 1, installsPrior: null,
             estimated: false, atRepoRoot: false, scan: "clean", scanFindings: [], scanAdvisories: [] }] });

describe("refreshIndex", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-idx-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the index on success", async () => {
    const r = await refreshIndex({ dir, fetchImpl: (async () => new Response(body, { status: 200 })) as any });
    expect(r.updated).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).skillCount).toBe(1);
  });

  it("keeps the existing index when the download fails", async () => {
    fs.writeFileSync(path.join(dir, "index.json"), '{"kept":true}');
    const r = await refreshIndex({ dir, fetchImpl: (async () => new Response("nope", { status: 500 })) as any });
    expect(r.updated).toBe(false);
    expect(fs.readFileSync(path.join(dir, "index.json"), "utf8")).toBe('{"kept":true}');
  });

  it("rejects a body that is not a valid index and leaves the old file", async () => {
    fs.writeFileSync(path.join(dir, "index.json"), '{"kept":true}');
    const r = await refreshIndex({ dir, fetchImpl: (async () => new Response("{}", { status: 200 })) as any });
    expect(r.updated).toBe(false);
    expect(fs.readFileSync(path.join(dir, "index.json"), "utf8")).toBe('{"kept":true}');
  });

  it("leaves no temp file behind after a rejected download", async () => {
    await refreshIndex({ dir, fetchImpl: (async () => new Response("{}", { status: 200 })) as any });
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("never throws when fetch itself rejects", async () => {
    const r = await refreshIndex({ dir, fetchImpl: (async () => { throw new Error("offline"); }) as any });
    expect(r.updated).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  // The test harness (test/integration.test.ts's runCli) sets this on every
  // spawned CLI process so `npm test` never touches the network — see
  // refresh.ts. Proven here at the unit level: fetchImpl throws if it is
  // ever called, so a passing test means the network path was never reached.
  it("skips the network entirely when METASKILL_SKIP_INDEX_REFRESH is set", async () => {
    const prev = process.env.METASKILL_SKIP_INDEX_REFRESH;
    process.env.METASKILL_SKIP_INDEX_REFRESH = "1";
    try {
      const fetchImpl = (async () => {
        throw new Error("fetchImpl must not be called when the skip flag is set");
      }) as any;
      const r = await refreshIndex({ dir, fetchImpl });
      expect(r.updated).toBe(false);
      expect(r.reason).toContain("METASKILL_SKIP_INDEX_REFRESH");
      expect(fs.existsSync(path.join(dir, "index.json"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.METASKILL_SKIP_INDEX_REFRESH;
      else process.env.METASKILL_SKIP_INDEX_REFRESH = prev;
    }
  });
});
