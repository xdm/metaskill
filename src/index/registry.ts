import type { RegistrySkill } from "./types.js";

const SEARCH_URL = "https://skills.sh/api/search?q=";

// The API rejects queries under 2 characters and caps every response at 100
// results with no pagination, so full coverage means many small queries whose
// result sets overlap. Two-letter grams are the cheapest probe that returns
// anything at all.
export const SWEEP_GRAMS: readonly string[] = [
  "ab", "ac", "ad", "ai", "al", "an", "ap", "ar", "as", "au", "ba", "be", "bo", "br", "bu",
  "ca", "ch", "ci", "cl", "co", "cr", "cu", "da", "de", "di", "do", "dr", "du", "ec", "ed",
  "el", "em", "en", "er", "es", "ex", "fa", "fi", "fl", "fo", "fr", "fu", "ga", "ge", "gi",
  "go", "gr", "gu", "ha", "he", "ho", "hu", "ic", "id", "im", "in", "io", "is", "it", "ja",
  "jo", "js", "ka", "ke", "ki", "ko", "la", "le", "li", "lo", "ma", "me", "mi", "mo", "mu",
  "na", "ne", "no", "nu", "ob", "oc", "on", "op", "or", "ou", "pa", "pe", "ph", "pi", "pl",
  "po", "pr", "pu", "py", "qu", "ra", "re", "ri", "ro", "ru", "sa", "sc", "se", "sh", "si",
  "sk", "sl", "sm", "so", "sp", "sq", "st", "su", "sw", "sy", "ta", "te", "th", "ti", "to",
  "tr", "tu", "tw", "ty", "ui", "un", "up", "ur", "us", "va", "ve", "vi", "vo", "wa", "we",
  "wi", "wo", "wr", "xl", "ya", "yo", "za", "zi",
];

export interface SweepOpts {
  fetchImpl?: typeof fetch;
  grams?: readonly string[];
  timeoutMs?: number;
  onProgress?: (gram: string, total: number) => void;
}

interface RawSkill {
  name?: unknown;
  source?: unknown;
  installs?: unknown;
}

export function parseSearchResponse(json: unknown): RegistrySkill[] {
  const skills = (json as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  const out: RegistrySkill[] = [];
  for (const s of skills as RawSkill[]) {
    if (typeof s?.name !== "string" || typeof s?.source !== "string") continue;
    out.push({
      name: s.name,
      source: s.source,
      installs: typeof s.installs === "number" ? s.installs : 0,
    });
  }
  return out;
}

function key(s: RegistrySkill): string {
  return `${s.source}@${s.name}`;
}

// One gram failing must not sink the build — a partial index beats no index,
// and the next scheduled run picks up whatever this one missed.
export async function sweepRegistry(opts: SweepOpts = {}): Promise<RegistrySkill[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const grams = opts.grams ?? SWEEP_GRAMS;
  const merged = new Map<string, RegistrySkill>();

  for (const gram of grams) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetchImpl(`${SEARCH_URL}${encodeURIComponent(gram)}`, { signal: ctrl.signal });
      if (!res.ok) continue;
      for (const s of parseSearchResponse(await res.json())) {
        const prev = merged.get(key(s));
        if (!prev || s.installs > prev.installs) merged.set(key(s), s);
      }
    } catch {
      /* one bad gram, keep sweeping */
    } finally {
      clearTimeout(timer);
    }
    opts.onProgress?.(gram, merged.size);
  }
  return [...merged.values()];
}
