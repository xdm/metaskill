import { locateInstalled } from "../install.js";
import { readLock } from "../lock.js";

// `metaskill list` — what metaskill has installed, from skills-lock.json.
// One line per skill; flags entries whose files are gone from disk.
export function listCommand(): number {
  const entries = Object.values(readLock()).sort((a, b) =>
    b.installedAt.localeCompare(a.installedAt),
  );
  if (!entries.length) {
    process.stdout.write(
      "metaskill hasn't installed anything yet.\n" +
        "(`metaskill log` shows routing decisions, including skills that were already present.)\n",
    );
    return 0;
  }

  const rows = entries.map((e) => ({
    skill: e.skill,
    pkg: e.pkg,
    version: e.version ? `v${e.version}` : "-",
    domain: e.domain ?? "-",
    date: e.installedAt.slice(0, 10),
    status: locateInstalled(e.skill) ? "ok" : "MISSING (removed?)",
  }));

  const headers = { skill: "SKILL", pkg: "PACKAGE", version: "VERSION", domain: "MATCHED", date: "INSTALLED", status: "STATUS" };
  const cols = Object.keys(headers) as (keyof typeof headers)[];
  const width = (c: (typeof cols)[number]) =>
    Math.max(headers[c].length, ...rows.map((r) => r[c].length));
  const line = (r: Record<(typeof cols)[number], string>) =>
    cols.map((c) => r[c].padEnd(width(c))).join("  ").trimEnd();

  process.stdout.write(line(headers) + "\n");
  for (const r of rows) process.stdout.write(line(r) + "\n");
  return 0;
}
