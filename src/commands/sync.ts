import { execFile } from "node:child_process";
import fs from "node:fs";
import { publisherOf } from "../discover.js";
import { parseFrontmatter } from "../frontmatter.js";
import { loadIndex } from "../index/read.js";
import { refreshIndex } from "../index/refresh.js";
import { readLock, writeLock } from "../lock.js";
import { pruneLog } from "../log.js";
import { agentsSkillsDir, claudeUserSkillsDir, skillsCmd } from "../paths.js";
import { loadPolicy } from "../policy.js";
import { protocolText } from "../protocol.js";
import { readState, writeState } from "../state.js";
import { blockedByScan } from "./update.js";
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
  // The protocol is the product, so it goes out before the 24h gate, before the
  // lock is read, and before any network call: neither an early return, nor a
  // 12-20s index download, nor a hook killed mid-download may cost the session
  // its protocol. Exactly one emit() per run — a second JSON line on stdout is
  // not a documented hook contract — so notices about the slow work below are
  // parked in state.json and ride out on the NEXT session's emit.
  const state = readState();
  const notices = state.pendingNotices ?? [];
  emit([protocolText(), ...notices].join("\n"));
  try {
    if (notices.length) writeState({ ...state, pendingNotices: [] });
    if (!opts.force && state.lastSyncTs && Date.now() - Date.parse(state.lastSyncTs) < DAY_MS) {
      return 0;
    }
    // Stamp first: a failing registry must not make every session retry.
    // Merge, never replace: pendingNotices must survive this write.
    writeState({ ...readState(), lastSyncTs: new Date().toISOString() });

    // Runs unconditionally in this branch — even with no skills locked — so
    // the local index still gets the upgrade path off the packaged snapshot.
    // The protocol block above is already out, so however long this takes, and
    // whether or not it succeeds, the session has what it needs.
    const idx = await refreshIndex();

    const policy = loadPolicy();
    pruneLog(policy);

    const lock = readLock();
    const entries = Object.values(lock);
    if (!entries.length) return 0;

    // Spec §7 Defect 1 reaches here too: the allowlist lowers the install
    // threshold, it never waives the scan, and this path runs unattended on a
    // timer. `index` is whatever refreshIndex() above just landed, or the
    // packaged snapshot, or null — blockedByScan treats all three safely.
    const index = loadIndex();
    const allowlisted = entries.filter(
      (e) => policy.trust.allowlist.includes(publisherOf(e.pkg)) && !blockedByScan(index, e.pkg),
    );
    const others = entries.filter((e) => !policy.trust.allowlist.includes(publisherOf(e.pkg)));
    // Allowlisted but scanned dirty: excluded from `allowlisted` above, so the
    // update call below never touches it — but unlike `others` this is not a
    // trust-tier skip, so it must not vanish from the report silently.
    const dirtyBlocked = entries.filter(
      (e) => policy.trust.allowlist.includes(publisherOf(e.pkg)) && blockedByScan(index, e.pkg),
    );

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
    if (idx.updated) lines.push(`[metaskill] Skill index refreshed: ${idx.skillCount} skills.`);
    if (updated.length) lines.push(`[metaskill] Updated skills: ${updated.join(", ")}.`);
    for (const e of dirtyBlocked) {
      lines.push(
        `[metaskill] Skipped ${e.skill}: index scan is dirty (${blockedByScan(index, e.pkg)}) — no flag bypasses a dirty scan.`,
      );
    }
    if (others.length) {
      lines.push(
        `[metaskill] Skills outside the allowlist are never auto-updated: ${others
          .map((e) => e.skill)
          .join(", ")} — run \`metaskill update\` to update them.`,
      );
    }
    if (lines.length) writeState({ ...readState(), pendingNotices: lines });
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] sync error: ${(err as Error).message}\n`);
    return 0;
  }
}
