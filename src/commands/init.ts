import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  claudeUserDir,
  claudeUserSkillsDir,
  cliEntryPath,
  metaskillHome,
  packageRoot,
  policyPath,
  projectSettingsPath,
  skillsCmd,
  userSettingsPath,
} from "../paths.js";
import { addHooks, removeHooks, type Settings } from "../settings.js";

// ~/.claude/commands/metaskill/<name>.md -> /metaskill:<name> in Claude Code.
// Shipped as templates; {{METASKILL}} is resolved to this install's absolute
// CLI path (same reasoning as the hooks: must work before any global install).
function commandsDstDir(): string {
  return path.join(claudeUserDir(), "commands", "metaskill");
}

function installSlashCommands(): string[] {
  const src = path.join(packageRoot(), "commands");
  const dst = commandsDstDir();
  const cli = `node "${cliEntryPath()}"`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(src).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const f of names) {
    const body = fs.readFileSync(path.join(src, f), "utf8").replaceAll("{{METASKILL}}", cli);
    fs.writeFileSync(path.join(dst, f), body);
  }
  return names.map((f) => `/metaskill:${f.replace(/\.md$/, "")}`);
}

function checkSkillsCli(): Promise<boolean> {
  return new Promise((resolve) => {
    const [bin, ...args] = [...skillsCmd(), "--version"];
    execFile(bin!, args, { timeout: 30_000, windowsHide: true }, (err) => resolve(!err));
  });
}

function readSettings(file: string): Settings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {}; // missing file — start fresh
  }
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    return null; // present but unparseable — never overwrite it
  }
}

function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export interface InitFlags {
  project?: boolean;
  uninstall?: boolean;
}

// `metaskill init` (spec 4.1): hooks + policy template + metaskill SKILL.md.
// Idempotent; --uninstall removes hooks and the SKILL.md but leaves
// ~/.metaskill (policy, log, lock) untouched.
export async function initCommand(flags: InitFlags): Promise<number> {
  const settingsFile = flags.project ? projectSettingsPath(process.cwd()) : userSettingsPath();
  const settings = readSettings(settingsFile);
  if (settings === null) {
    process.stderr.write(
      `metaskill: ${settingsFile} exists but is not valid JSON — fix it first, nothing was changed.\n`,
    );
    return 1;
  }

  const metaskillSkillDir = path.join(claudeUserSkillsDir(), "metaskill");

  if (flags.uninstall) {
    writeSettings(settingsFile, removeHooks(settings));
    fs.rmSync(metaskillSkillDir, { recursive: true, force: true });
    fs.rmSync(commandsDstDir(), { recursive: true, force: true });
    process.stdout.write(
      `metaskill: hooks removed from ${settingsFile}; ${metaskillSkillDir} and /metaskill:* commands removed.\n` +
        `Kept: ${metaskillHome()} (policy, log, lock) and all installed skills.\n`,
    );
    return 0;
  }

  writeSettings(settingsFile, addHooks(settings));

  // Policy template only if absent — never clobber user edits.
  if (!fs.existsSync(policyPath())) {
    fs.mkdirSync(metaskillHome(), { recursive: true });
    fs.copyFileSync(path.join(packageRoot(), "templates", "metaskill.yaml"), policyPath());
  }

  // The metaskill protocol skill is ours; overwrite so re-init upgrades it.
  fs.mkdirSync(metaskillSkillDir, { recursive: true });
  fs.copyFileSync(path.join(packageRoot(), "skill", "SKILL.md"), path.join(metaskillSkillDir, "SKILL.md"));

  const slashCommands = installSlashCommands();

  const skillsOk = await checkSkillsCli();

  process.stdout.write(
    [
      `metaskill: hooks registered in ${settingsFile} (UserPromptSubmit -> route, SessionStart -> sync).`,
      `Policy: ${policyPath()}`,
      `Skill: ${path.join(metaskillSkillDir, "SKILL.md")}`,
      ...(slashCommands.length ? [`Slash commands: ${slashCommands.join(", ")} (new Claude Code sessions)`] : []),
      skillsOk
        ? `skills CLI: ok (${skillsCmd().join(" ")})`
        : `WARNING: \`${skillsCmd().join(" ")}\` failed — install Node >= 20 and check network; metaskill route will not be able to install skills until it works.`,
      "",
    ].join("\n"),
  );
  return 0;
}
