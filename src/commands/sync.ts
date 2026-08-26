import { execFile } from "node:child_process";
import fs from "node:fs";
import { publisherOf } from "../discover.js";
import { parseFrontmatter } from "../frontmatter.js";
import { readLock, writeLock } from "../lock.js";
import { pruneLog } from "../log.js";
import { agentsSkillsDir, claudeUserSkillsDir, skillsCmd } from "../paths.js";
import { loadPolicy } from "../policy.js";
import { readState, writeState } from "../state.js";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function run(cmd: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    execFile(bin!, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

function installedVersion(skill: string): string | undefined {
  for (const dir of [claudeUserSkillsDir(), agentsSkillsDir()]) {
    try {
      const md = fs.readFileSync(path.join(dir, skill, "SKILL.md"), "utf8");
      return parseFrontmatter(md).version;
    } catch {
      /* try next dir */
    }
  }
  return undefined;
}

function emit(context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }) + "\n",
  );
}

// SessionStart hook body (spec 4.3), at most once per 24h. The skills CLI has
// no `check` command (verified v1.5.23), so: allowlisted publishers get
// `skills update <names> -g -y`; everything else gets a notice line.
export async function syncCommand(opts: { force?: boolean } = {}): Promise<number> {
  try {
    const state = readState();
    if (!opts.force && state.lastSyncTs && Date.now() - Date.parse(state.lastSyncTs) < DAY_MS) {
      return 0;
    }
    // Stamp first: a failing registry must not make every session retry.
    writeState({ lastSyncTs: new Date().toISOString() });

    const policy = loadPolicy();
    pruneLog(policy);

    const lock = readLock();
    const entries = Object.values(lock);
    if (!entries.length) return 0;

    const allowlisted = entries.filter((e) => policy.trust.allowlist.includes(publisherOf(e.pkg)));
    const others = entries.filter((e) => !policy.trust.allowlist.includes(publisherOf(e.pkg)));

    const updated: string[] = [];
    if (allowlisted.length) {
      const before = new Map(allowlisted.map((e) => [e.skill, installedVersion(e.skill)]));
      try {
        await run([...skillsCmd(), "update", ...allowlisted.map((e) => e.skill), "-g", "-y"], 120_000);
        for (const e of allowlisted) {
          const now = installedVersion(e.skill);
          if (now !== before.get(e.skill)) updated.push(e.skill);
          lock[e.pkg] = { ...e, version: now ?? e.version };
        }
        writeLock(lock);
      } catch (err) {
        process.stderr.write(`[metaskill] sync update failed: ${(err as Error).message}\n`);
      }
    }

    const lines: string[] = [];
    if (updated.length) lines.push(`[metaskill] Updated skills: ${updated.join(", ")}.`);
    if (others.length) {
      lines.push(
        `[metaskill] Skills outside the allowlist are never auto-updated: ${others
          .map((e) => e.skill)
          .join(", ")} — run \`metaskill update\` to update them.`,
      );
    }
    if (lines.length) emit(lines.join("\n"));
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] sync error: ${(err as Error).message}\n`);
    return 0;
  }
}
