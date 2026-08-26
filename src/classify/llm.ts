import { DOMAIN_IDS } from "../taxonomy.js";

export interface LlmResult {
  domains: string[];
  trivial: boolean;
}

export interface LlmOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiKey?: string;
  domainIds?: ReadonlySet<string>; // custom_domains-aware id set
}

function buildSystem(ids: ReadonlySet<string>): string {
  return [
    "You classify a user's task prompt into skill domains for a coding agent.",
    "Respond with ONLY a JSON object, no prose: {\"domains\": string[], \"trivial\": boolean}.",
    "domains: 0-3 items, each EXACTLY one of:",
    [...ids].join(", "),
    "trivial: true only for greetings, smalltalk, or questions answerable without any tools.",
  ].join("\n");
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Returns null on ANY failure (no key, timeout, HTTP error, bad JSON) —
// callers fall back to heuristics (spec 4.2.2). Never throws.
export async function classifyLlm(
  prompt: string,
  stackHint: string[],
  model: string,
  opts: LlmOpts = {},
): Promise<LlmResult | null> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const ids = opts.domainIds ?? DOMAIN_IDS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: buildSystem(ids),
        messages: [
          {
            role: "user",
            content:
              `Task prompt:\n${prompt.slice(0, 2000)}\n\n` +
              (stackHint.length ? `Project stack: ${stackHint.join(", ")}\n` : "") +
              "JSON:",
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = data.content?.find((b) => typeof b.text === "string")?.text;
    if (!text) return null;
    const jsonStr = extractJson(text);
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as { domains?: unknown; trivial?: unknown };
    const domains = Array.isArray(parsed.domains)
      ? [...new Set(parsed.domains.filter((d): d is string => typeof d === "string" && ids.has(d)))]
      : [];
    return { domains: domains.slice(0, 4), trivial: parsed.trivial === true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
