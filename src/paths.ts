import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/paths.js -> package root; templates/ and skill/ ship in the package
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
}

// Every command metaskill asks the in-session model to run — the SessionStart
// protocol and `find`'s own output — must name the SAME interpreter and path.
// `metaskill` is not on PATH for a plugin-cache or npx install, so the bare
// name is the spelling most likely to fail; and two different spellings in one
// turn is a reason for a model to trust neither.
export function metaskillCmd(): string {
  return `node "${cliEntryPath()}"`;
}

// init copies the package here and points hooks at it, so `npx ... init`
// survives npx cache pruning and node version switches (the running copy's
// own path is ephemeral in both cases).
export function stablePkgDir(): string {
  return path.join(metaskillHome(), "bin");
}

export function stableCliPath(): string {
  return path.join(stablePkgDir(), "dist", "cli.js");
}

export function metaskillHome(): string {
  return process.env.METASKILL_HOME ?? path.join(os.homedir(), ".metaskill");
}

export function policyPath(): string {
  return path.join(metaskillHome(), "metaskill.yaml");
}

export function cachePath(): string {
  return path.join(metaskillHome(), "cache.json");
}

export function lockPath(): string {
  return path.join(metaskillHome(), "skills-lock.json");
}

export function statePath(): string {
  return path.join(metaskillHome(), "state.json");
}

export function defaultLogPath(): string {
  return path.join(metaskillHome(), "log.jsonl");
}

export function claudeUserDir(): string {
  return path.join(os.homedir(), ".claude");
}

export function claudeUserSkillsDir(): string {
  return path.join(claudeUserDir(), "skills");
}

// `skills add -g` installs here and symlinks into agent dirs (verified v1.5.23).
export function agentsSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function userSettingsPath(): string {
  return path.join(claudeUserDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".claude", "settings.json");
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".claude", "skills");
}

// Quote-aware split: node install paths routinely contain spaces
// ("Application Support", "Program Files"), so a plain \s+ split corrupts them.
function splitCmd(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The skills CLI is a runtime dependency invoked via npx, pinned to the
// version this release was tested against. Tests override with a local stub.
export function skillsCmd(): string[] {
  const env = process.env.METASKILL_SKILLS_CMD;
  if (env && env.trim().length > 0) return splitCmd(env);
  return ["npx", "-y", "skills@1.5.23"];
}
