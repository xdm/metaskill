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
  it("unions results across grams and dedupes by (source, name)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => REAL_RESPONSE } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ fetchImpl, grams: ["re", "ac"] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://skills.sh/api/search?q=re");
    expect(out).toHaveLength(2); // deduped, not 4
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

    const out = await sweepRegistry({ fetchImpl, grams: ["aa", "bb"] });
    expect(out).toEqual([{ name: "s", source: "a/b", installs: 99 }]);
  });

  it("survives a failing gram without losing the others", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("bad")) throw new Error("network down");
      return { ok: true, json: async () => REAL_RESPONSE } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await sweepRegistry({ fetchImpl, grams: ["bad", "ok"] });
    expect(out).toHaveLength(2);
  });
});
