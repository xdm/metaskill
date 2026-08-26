import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyLlm } from "../src/classify/llm.js";

function fakeResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("classifyLlm", () => {
  it("returns validated domains and drops out-of-taxonomy ones", async () => {
    const r = await classifyLlm("do xlsx things", [], "claude-haiku-4-5", {
      apiKey: "k",
      fetchImpl: async () => fakeResponse('{"domains": ["xlsx", "blockchain", "python"], "trivial": false}'),
    });
    expect(r).toEqual({ domains: ["xlsx", "python"], trivial: false });
  });

  it("extracts JSON embedded in prose", async () => {
    const r = await classifyLlm("p", [], "m", {
      apiKey: "k",
      fetchImpl: async () => fakeResponse('Sure! {"domains": ["pdf"], "trivial": false} hope that helps'),
    });
    expect(r?.domains).toEqual(["pdf"]);
  });

  it("returns null without an API key and never calls fetch", async () => {
    let called = false;
    const r = await classifyLlm("p", [], "m", {
      fetchImpl: async () => {
        called = true;
        return fakeResponse("{}");
      },
    });
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null on timeout (3s budget, spec 4.2.2)", async () => {
    const r = await classifyLlm("p", [], "m", {
      apiKey: "k",
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    expect(r).toBeNull();
  });

  it("returns null on HTTP error and on garbage output", async () => {
    const err = await classifyLlm("p", [], "m", {
      apiKey: "k",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(err).toBeNull();
    const garbage = await classifyLlm("p", [], "m", {
      apiKey: "k",
      fetchImpl: async () => fakeResponse("no json here at all"),
    });
    expect(garbage).toBeNull();
  });
});
