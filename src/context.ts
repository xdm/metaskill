import os from "node:os";
import type { Candidate } from "./types.js";

export interface RouteReport {
  domains: string[];
  installedNow: { pkg: string; version?: string; path?: string }[];
  present: { domain: string; skill: string }[];
  ask: { candidate: Candidate; reason: string }[];
  denied: number;
}

const MAX_CHARS = 600; // spec 4.2.7

function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// Builds the [metaskill] additionalContext block (spec 4.2.7). Returns null
// when there is nothing actionable — "if there are no candidates — solve the
// task, report nothing" (spec 4.8).
export function buildContext(r: RouteReport): string | null {
  if (!r.installedNow.length && !r.present.length && !r.ask.length && !r.denied) return null;

  const lines: string[] = [`[metaskill] Domains: ${r.domains.join(", ")}.`];
  for (const i of r.installedNow) {
    const v = i.version ? ` (v${i.version})` : "";
    const p = i.path ? ` → ${shortenHome(i.path)}` : "";
    lines.push(`Installed now: ${i.pkg}${v}${p}`);
  }
  if (r.present.length) {
    lines.push(`Already present: ${r.present.map((p) => p.skill).join(", ")}`);
  }
  for (const a of r.ask) {
    lines.push(
      `Needs confirmation: ${a.candidate.pkg} (${a.candidate.installs} installs, ${a.reason}) — ask the user one question before using it.`,
    );
  }
  if (r.denied) {
    lines.push(`Skipped by policy: ${r.denied} (see metaskill log).`);
  }

  // Whole-line truncation, priority = line order (domains + installs first)
  const out: string[] = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_CHARS) break;
    out.push(line);
    len += line.length + 1;
  }
  return out.join("\n");
}
