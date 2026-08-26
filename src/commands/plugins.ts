import { findPlugins, readMarketplaces } from "../plugins.js";

// `metaskill plugins <query>` — search the marketplace catalogs Claude Code
// already keeps on disk. Never installs: plugins can carry hooks and MCP
// servers, so installation stays an explicit human decision.
export function pluginsCommand(query: string[]): number {
  const catalogs = readMarketplaces();
  if (!catalogs.length) {
    process.stdout.write(
      "No plugin marketplaces on this machine yet.\n" +
        "Add one inside Claude Code first, e.g. `/plugin marketplace add anthropics/claude-plugins-public`.\n",
    );
    return 0;
  }
  const total = catalogs.reduce((n, c) => n + c.entries.length, 0);

  if (!query.length) {
    process.stdout.write(
      `${total} plugins across ${catalogs.length} marketplace(s): ` +
        catalogs.map((c) => `${c.marketplace} (${c.entries.length})`).join(", ") +
        "\nUsage: metaskill plugins <words describing the task>\n",
    );
    return 0;
  }

  const hits = findPlugins(query.join(" "), 5);
  if (!hits.length) {
    process.stdout.write(`No plugin in the local catalogs matches "${query.join(" ")}".\n`);
    return 0;
  }

  for (const p of hits) {
    const mark = p.installed ? "[installed] " : "";
    process.stdout.write(`${mark}${p.name}@${p.marketplace}  ${p.description.slice(0, 100)}\n`);
  }
  process.stdout.write(
    "\nPlugins are never installed automatically (they can add hooks and MCP servers).\n" +
      "To install one: /plugin install <name>@<marketplace>\n",
  );
  return 0;
}
