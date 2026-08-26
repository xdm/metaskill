import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Policy, RouteLogEntry } from "./types.js";

export function hashPrompt(prompt: string): string {
  return "sha256:" + crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function appendLog(entry: RouteLogEntry, policy: Policy): void {
  try {
    fs.mkdirSync(path.dirname(policy.log.path), { recursive: true });
    fs.appendFileSync(policy.log.path, JSON.stringify(entry) + "\n");
  } catch {
    /* logging must never break the hook */
  }
}

export function readLogEntries(policy: Policy, n?: number): RouteLogEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(policy.log.path, "utf8");
  } catch {
    return [];
  }
  const entries: RouteLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as RouteLogEntry);
    } catch {
      /* skip corrupt line */
    }
  }
  return n ? entries.slice(-n) : entries;
}

// Drops entries older than retention_days. Called from sync (daily), not from
// route — route stays on its 1.5s budget.
export function pruneLog(policy: Policy, now: Date = new Date()): void {
  const entries = readLogEntries(policy);
  if (!entries.length) return;
  const cutoff = now.getTime() - policy.log.retentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => Date.parse(e.ts) >= cutoff);
  if (kept.length === entries.length) return;
  try {
    fs.writeFileSync(policy.log.path, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  } catch {
    /* best effort */
  }
}
