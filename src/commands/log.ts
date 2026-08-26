import { readLogEntries } from "../log.js";
import { loadPolicy } from "../policy.js";

// `metaskill log [-n N]` — human-readable tail of the JSONL log.
export function logCommand(n: number): number {
  const policy = loadPolicy();
  const entries = readLogEntries(policy, n);
  if (!entries.length) {
    process.stdout.write(`No log entries at ${policy.log.path}.\n`);
    return 0;
  }
  for (const e of entries) {
    const parts = [
      e.ts,
      `domains=[${e.domains.join(",")}]`,
      e.covered.length ? `covered=[${e.covered.join(",")}]` : null,
      e.installed.length ? `installed=[${e.installed.join(",")}]` : null,
      ...e.discovered
        .filter((d) => !e.installed.includes(d.pkg))
        .map((d) => `${d.decision}:${d.pkg}(${d.installs},scan=${d.scan})`),
      `${e.latency_ms}ms`,
      e.llm_used ? "llm" : null,
    ].filter(Boolean);
    process.stdout.write(parts.join(" ") + "\n");
  }
  return 0;
}
