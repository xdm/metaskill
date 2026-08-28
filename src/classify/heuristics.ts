import fs from "node:fs";
import path from "node:path";
import { TAXONOMY, type DomainDef } from "../taxonomy.js";

type Taxonomy = readonly DomainDef[];
import type { HeuristicResult } from "../types.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(promptLower: string, kw: string): boolean {
  // Word-boundary match for plain ASCII tokens; substring match for phrases,
  // punctuation-bearing tokens, and non-ASCII (JS \b is ASCII-only).
  const plainToken = /^[a-z0-9_]+$/.test(kw);
  if (!plainToken) return promptLower.includes(kw);
  return new RegExp(`\\b${escapeRe(kw)}\\b`).test(promptLower);
}

function promptDomains(promptLower: string, taxonomy: Taxonomy): string[] {
  const hits: { id: string; count: number }[] = [];
  for (const d of taxonomy) {
    let count = 0;
    for (const kw of d.keywords) if (keywordMatches(promptLower, kw)) count++;
    for (const ext of d.extensions) {
      if (new RegExp(`\\.${escapeRe(ext)}\\b`).test(promptLower)) count += 2;
    }
    if (count > 0) hits.push({ id: d.id, count });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.map((h) => h.id);
}

function readDeps(cwd: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    return new Set(Object.keys(deps));
  } catch {
    return new Set();
  }
}

export function detectStack(cwd: string, taxonomy: Taxonomy = TAXONOMY): string[] {
  const found: DomainDef[] = [];
  let deps: Set<string> | null = null;
  for (const d of taxonomy) {
    let hit = false;
    for (const f of d.files ?? []) {
      try {
        if (fs.existsSync(path.join(cwd, f))) hit = true;
      } catch {
        /* unreadable cwd — no stack signal */
      }
    }
    if (!hit && d.deps?.length) {
      deps ??= readDeps(cwd);
      if (d.deps.some((dep) => deps!.has(dep))) hit = true;
    }
    if (hit) found.push(d);
  }
  found.sort((a, b) => (b.stackPriority ?? 0) - (a.stackPriority ?? 0));
  return found.map((d) => d.id);
}

export function classifyHeuristic(
  prompt: string,
  cwd: string,
  trivialMaxChars: number,
  taxonomy: Taxonomy = TAXONOMY,
): HeuristicResult {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const fromPrompt = promptDomains(lower, taxonomy);

  // Triviality is structural, not linguistic (works identically in every
  // language): shorter than the threshold with zero domain signals means
  // greetings, acks, and one-liners that skills would not help with. Anything
  // longer that heuristics can't classify reaches the model-side fallback.
  if (trimmed.length < trivialMaxChars && fromPrompt.length === 0) {
    return { domains: [], confidence: "high", trivial: true, stackDomains: [] };
  }

  const stackDomains = detectStack(cwd, taxonomy);
  const domains = [...fromPrompt];
  // Stack domains only support a task that already has a subject — a bare
  // stack match on every prompt in the repo would be noise (e.g. xlsx from
  // the prompt combined with python from the stack, not python by itself).
  if (fromPrompt.length > 0) {
    for (const s of stackDomains.slice(0, 2)) {
      if (!domains.includes(s)) domains.push(s);
    }
  }

  return {
    domains: domains.slice(0, 4),
    confidence: fromPrompt.length > 0 ? "high" : "low",
    trivial: false,
    stackDomains,
  };
}
