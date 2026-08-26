import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlugins, formatPluginLine, installedPluginNames, readMarketplaces } from "../src/plugins.js";

let home: string;
const savedHome = process.env.HOME;

function addMarketplace(name: string, plugins: unknown[]) {
  const dir = path.join(home, ".claude", "plugins", "marketplaces", name, ".claude-plugin");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marketplace.json"), JSON.stringify({ name, plugins }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-plug-"));
  process.env.HOME = home;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
});

describe("plugin catalogs", () => {
  it("reads every marketplace Claude Code keeps on disk", () => {
    addMarketplace("claude-plugins-official", [
      { name: "figma", description: "Figma design platform integration", category: "design", author: { name: "Figma" } },
    ]);
    addMarketplace("team-marketplace", [{ name: "internal-tool", description: "Company workflows" }]);
    const catalogs = readMarketplaces();
    expect(catalogs.map((c) => c.marketplace).sort()).toEqual(["claude-plugins-official", "team-marketplace"]);
    expect(catalogs.flatMap((c) => c.entries)).toHaveLength(2);
  });

  it("returns nothing when no marketplace exists, instead of throwing", () => {
    expect(readMarketplaces()).toEqual([]);
    expect(findPlugins("anything")).toEqual([]);
  });

  it("ranks name matches above description matches and ignores weak hits", () => {
    addMarketplace("m", [
      { name: "figma", description: "design files" },
      { name: "unrelated", description: "mentions figma once in passing" },
      { name: "notion", description: "notes" },
    ]);
    const hits = findPlugins("figma design", 5);
    expect(hits[0]!.name).toBe("figma");
    // description-only match scores too low to be suggested
    expect(hits.map((h) => h.name)).not.toContain("unrelated");
    expect(hits.map((h) => h.name)).not.toContain("notion");
  });

  it("marks plugins that are already installed", () => {
    addMarketplace("m", [{ name: "figma", description: "design files" }]);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "figma@m": true } }),
    );
    expect(installedPluginNames().has("figma")).toBe(true);
    const hit = findPlugins("figma", 1)[0]!;
    expect(hit.installed).toBe(true);
    expect(formatPluginLine(hit)).toContain("already installed");
  });

  it("formats an install suggestion with marketplace and author", () => {
    addMarketplace("official", [
      { name: "figma", description: "Figma design platform integration", author: { name: "Figma" } },
    ]);
    const line = formatPluginLine(findPlugins("figma", 1)[0]!);
    expect(line).toContain("Plugin available: figma@official");
    expect(line).toContain("by Figma");
  });
});
