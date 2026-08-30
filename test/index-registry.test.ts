import { describe, expect, it } from "vitest";
import { parseSearchResponse, sweepRegistry } from "../src/index/registry.js";

// Captured verbatim from https://skills.sh/api/search?q=react on 2026-08-28.
const REAL_RESPONSE = {
  query: "react",
  searchType: "fuzzy",
  searchVersion: "legacy",
  skills: [
    {
      id: "vercel-labs/agent-skills/vercel-react-best-practices",
      skillId: "vercel-react-best-practices",
      name: "vercel-react-best-practices",
      installs: 670778,
      source: "vercel-labs/agent-skills",
    },
    {
      id: "vercel-labs/agent-skills/vercel-react-native-skills",
      skillId: "vercel-react-native-skills",
      name: "vercel-react-native-skills",
      installs: 197078,
      source: "vercel-labs/agent-skills",
    },
  ],
};

describe("parseSearchResponse", () => {
  it("maps the real API shape to RegistrySkill", () => {
    expect(parseSearchResponse(REAL_RESPONSE)).toEqual([
      { name: "vercel-react-best-practices", source: "vercel-labs/agent-skills", installs: 670778 },
      { name: "vercel-react-native-skills", source: "vercel-labs/agent-skills", installs: 197078 },
    ]);
  });

  it("returns [] for the error body and for junk", () => {
    expect(parseSearchResponse({ error: "Query must be at least 2 characters" })).toEqual([]);
    expect(parseSearchResponse(null)).toEqual([]);
    expect(parseSearchResponse({ skills: "nope" })).toEqual([]);
  });

  it("drops entries missing name or source", () => {
    const r = parseSearchResponse({ skills: [{ name: "x" }, { source: "a/b" }, ...REAL_RESPONSE.skills] });
    expect(r).toHaveLength(2);
  });
});

describe("sweepRegistry", () => {
  // Every case pins the pacing to zero: what is under test is which requests
  // happen and what survives them, never how long the sweep waits between.
  const fast = { minIntervalMs: 0, backoffMs: 0 };

  it("unions results across grams and dedupes by (source, name)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => REAL_RESPONSE } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["re", "ac"] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://skills.sh/api/search?q=re");
    expect(out.skills).toHaveLength(2); // deduped, not 4
    expect(out.failedGrams).toEqual([]);
  });

  it("keeps the highest install count when a skill appears twice", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return {
        ok: true,
        json: async () => ({ skills: [{ name: "s", source: "a/b", installs: n === 1 ? 10 : 99 }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["aa", "bb"] });
    expect(out.skills).toEqual([{ name: "s", source: "a/b", installs: 99 }]);
  });

  it("survives a failing gram without losing the others, and names it", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("bad")) throw new Error("network down");
      return { ok: true, json: async () => REAL_RESPONSE } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["bad", "ok"] });
    expect(out.skills).toHaveLength(2);
    // Silently dropping this was the whole failure mode: a 429 body parses as
    // an empty result set, so a lost gram looked exactly like a sparse one.
    expect(out.failedGrams).toEqual(["bad"]);
  });

  it("retries a rate-limited gram and keeps its results", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return { ok: false, status: 429, json: async () => ({ error: "rate_limit_exceeded" }) } as unknown as Response;
      return { ok: true, json: async () => REAL_RESPONSE } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["re"] });
    expect(n).toBe(2);
    expect(out.skills).toHaveLength(2);
    expect(out.failedGrams).toEqual([]);
  });

  it("reports a gram the endpoint rate-limits every time", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return { ok: false, status: 429, json: async () => ({ error: "rate_limit_exceeded" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["re"] });
    expect(out.skills).toEqual([]);
    expect(out.failedGrams).toEqual(["re"]);
    expect(n).toBe(2); // one attempt, one retry, then it stops asking
  });

  it("does not retry a 4xx that a retry cannot fix", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return { ok: false, status: 400, json: async () => ({ error: "too short" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ ...fast, fetchImpl, grams: ["a"] });
    expect(n).toBe(1);
    expect(out.failedGrams).toEqual(["a"]);
  });

  it("gives up on the rest once the endpoint has failed 20 grams in a row", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const grams = Array.from({ length: 40 }, (_, i) => `g${i}`);
    const out = await sweepRegistry({ ...fast, fetchImpl, grams });
    expect(n).toBe(40); // 20 grams x 2 attempts, not 80
    // The abandoned grams are still reported as failed: the caller decides on
    // the tally, and calling them "not attempted" would understate the gap.
    expect(out.failedGrams).toEqual(grams);
  });

  it("paces requests so the sweep stays under the endpoint's rate limit", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => REAL_RESPONSE }) as unknown as Response) as unknown as typeof fetch;

    const started = Date.now();
    await sweepRegistry({ fetchImpl, grams: ["aa", "bb", "cc"], minIntervalMs: 60, backoffMs: 0 });
    // Three grams means two gaps; the first request is not delayed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });
});
