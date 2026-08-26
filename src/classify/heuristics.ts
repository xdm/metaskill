import fs from "node:fs";
import path from "node:path";
import { TAXONOMY, type DomainDef } from "../taxonomy.js";
import type { HeuristicResult } from "../types.js";

const GREETING_RE =
  /^(hi|hello|hey|yo|thanks|thank you|ok|okay|good morning|привет|здравствуй(те)?|спасибо|ку)[\s!.,)]*$/i;

// Spec 4.2.1: short prompts with no action verbs are trivial. Both languages,
// because the classifier sees raw user prompts.
const ACTION_VERBS = [
  "fix", "add", "build", "create", "write", "implement", "make", "update",
  "remove", "delete", "migrate", "set up", "setup", "deploy", "convert",
  "generate", "optimize", "refactor", "design", "debug", "scrape", "translate",
  "configure", "install", "export", "import", "parse", "analyze", "automate",
  "сделай", "напиши", "добавь", "исправь", "создай", "перенеси", "экспортируй",
  "собери", "настрой", "переведи", "перепиши", "почини", "удали", "спарси",
];

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

function promptDomains(promptLower: string): string[] {
  const hits: { id: string; count: number }[] = [];
  for (const d of TAXONOMY) {
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

export function detectStack(cwd: string): string[] {
  const found: DomainDef[] = [];
  let deps: Set<string> | null = null;
  for (const d of TAXONOMY) {
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
): HeuristicResult {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();

  if (GREETING_RE.test(trimmed)) {
    return { domains: [], confidence: "high", trivial: true, stackDomains: [] };
  }

  const fromPrompt = promptDomains(lower);
  const hasVerb = ACTION_VERBS.some((v) =>
    /^[a-z ]+$/.test(v) ? new RegExp(`\\b${escapeRe(v)}\\b`).test(lower) : lower.includes(v),
  );

  if (trimmed.length < trivialMaxChars && fromPrompt.length === 0 && !hasVerb) {
    return { domains: [], confidence: "high", trivial: true, stackDomains: [] };
  }

  const stackDomains = detectStack(cwd);
  const domains = [...fromPrompt];
  // Stack domains only support a task that already has a subject — a bare
  // stack match on every prompt in the repo would be noise (spec §2 example:
  // xlsx from the prompt + python from the stack).
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
