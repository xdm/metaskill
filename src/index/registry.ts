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

// The endpoint answers past 30 requests a minute with 429, and its error body
// is valid JSON with no `skills` key — which parseSearchResponse reads as "no
// results". An unpaced sweep therefore loses grams without ever erroring, so
// the interval is the fix and everything below is only about noticing.
// 25/min leaves headroom under the published limit and costs about six minutes
// against the archive pass's forty.
const MIN_INTERVAL_MS = 2_400;
// Measured recovery from a 429 is ~12 seconds, so one wait past the window is
// enough for a gram that a burst pushed over the edge.
const BACKOFF_MS = 15_000;
const MAX_ATTEMPTS = 2;
// A run this long is the endpoint being down, not grams being unlucky. Each
// remaining gram would pay the full retry cost to learn the same thing, and
// the caller rejects the sweep on the tally either way.
const MAX_CONSECUTIVE_FAILURES = 20;

export interface SweepOpts {
  fetchImpl?: typeof fetch;
  grams?: readonly string[];
  timeoutMs?: number;
  minIntervalMs?: number;
  backoffMs?: number;
  onProgress?: (gram: string, total: number) => void;
}

export interface SweepResult {
  skills: RegistrySkill[];
  // Coverage is a union over grams, so a gram that never answered is skills
  // missing from the index rather than a slower build. Reported, not thrown
  // on: how much loss is tolerable is the caller's call, not the sweep's.
  failedGrams: string[];
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function sweepRegistry(opts: SweepOpts = {}): Promise<SweepResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const grams = opts.grams ?? SWEEP_GRAMS;
  const minInterval = opts.minIntervalMs ?? MIN_INTERVAL_MS;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const merged = new Map<string, RegistrySkill>();
  const failedGrams: string[] = [];
  let consecutiveFailures = 0;
  // Start-to-start pacing: the request's own latency counts toward the
  // interval, so a slow endpoint is never charged twice for it.
  let nextAt = 0;

  for (const [i, gram] of grams.entries()) {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      failedGrams.push(...grams.slice(i));
      break;
    }

    let answered = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !answered; attempt++) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt = Date.now() + minInterval;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
      try {
        const res = await fetchImpl(`${SEARCH_URL}${encodeURIComponent(gram)}`, { signal: ctrl.signal });
        if (res.ok) {
          for (const s of parseSearchResponse(await res.json())) {
            const prev = merged.get(key(s));
            if (!prev || s.installs > prev.installs) merged.set(key(s), s);
          }
          answered = true;
        } else if (res.status === 429 || res.status >= 500) {
          nextAt = Date.now() + backoff;
        } else {
          break; // a 4xx a retry cannot fix
        }
      } catch {
        /* network error or timeout; retrying at the normal interval is the whole response */
      } finally {
        clearTimeout(timer);
      }
    }

    if (answered) {
      consecutiveFailures = 0;
    } else {
      failedGrams.push(gram);
      consecutiveFailures++;
    }
    opts.onProgress?.(gram, merged.size);
  }

  return { skills: [...merged.values()], failedGrams };
}
