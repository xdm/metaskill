import fs from "node:fs";
import path from "node:path";
import { claudeUserDir, userSettingsPath } from "./paths.js";
import { readJsonFile } from "./store.js";

export interface PluginCandidate {
  name: string;
  marketplace: string;
  description: string;
  category?: string;
  author?: string;
  installed: boolean;
  score: number;
}

interface MarketplaceEntry {
  name?: string;
  description?: string;
  category?: string;
  keywords?: string[];
  tags?: string[];
  author?: { name?: string } | string;
}

export function marketplacesDir(): string {
  return path.join(claudeUserDir(), "plugins", "marketplaces");
}

function authorName(a: MarketplaceEntry["author"]): string | undefined {
  if (!a) return undefined;
  return typeof a === "string" ? a : a.name;
}

// Claude Code keeps every added marketplace catalog on disk and refreshes it
// on its own, so this is a local read: no network, no scraping.
export function readMarketplaces(): { marketplace: string; entries: MarketplaceEntry[] }[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(marketplacesDir());
  } catch {
    return [];
  }
  const out: { marketplace: string; entries: MarketplaceEntry[] }[] = [];
  for (const d of dirs) {
    const file = path.join(marketplacesDir(), d, ".claude-plugin", "marketplace.json");
    const data = readJsonFile<{ name?: string; plugins?: MarketplaceEntry[] }>(file, {});
    if (Array.isArray(data.plugins)) out.push({ marketplace: data.name ?? d, entries: data.plugins });
  }
  return out;
}

export function installedPluginNames(): Set<string> {
  const settings = readJsonFile<{ enabledPlugins?: Record<string, unknown> }>(userSettingsPath(), {});
  const names = new Set<string>();
  for (const key of Object.keys(settings.enabledPlugins ?? {})) names.add(key.split("@")[0]!);
  return names;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9+]+/i).filter((w) => w.length >= 3);
}

// Word-level scoring, name matches weigh most. Deliberately conservative:
// plugins are never auto-installed, so a near miss costs the user nothing but
// a declined question.
export function findPlugins(query: string, limit = 3): PluginCandidate[] {
  const words = [...new Set(tokenize(query))];
  if (!words.length) return [];
  const installed = installedPluginNames();
  const out: PluginCandidate[] = [];

  for (const { marketplace, entries } of readMarketplaces()) {
    for (const e of entries) {
      if (!e.name) continue;
      const name = e.name.toLowerCase();
      const haystack = [e.description, e.category, ...(e.keywords ?? []), ...(e.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const w of words) {
        if (name === w) score += 10;
        else if (name.includes(w)) score += 5;
        if (haystack.includes(w)) score += 1;
      }
      if (score < 5) continue; // description-only matches are too noisy
      out.push({
        name: e.name,
        marketplace,
        description: e.description ?? "",
        category: e.category,
        author: authorName(e.author),
        installed: installed.has(e.name),
        score,
      });
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function formatPluginLine(p: PluginCandidate): string {
  const who = p.author ? `, by ${p.author}` : "";
  return p.installed
    ? `Plugin already installed: ${p.name}`
    : `Plugin available: ${p.name}@${p.marketplace}${who} — ${p.description.slice(0, 90)}`;
}
