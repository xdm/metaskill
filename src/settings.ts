import { stableCliPath } from "./paths.js";

type HookEntry = { type?: string; command?: string; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
export type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export function hookCommand(sub: "route" | "sync"): string {
  // Always the stable self-installed copy (~/.metaskill/bin), never the
  // running instance's path — that one lives in the npx cache or a
  // node-version-specific global dir, both of which evaporate.
  return `node "${stableCliPath()}" ${sub}`;
}

export function isMetaskillHookCommand(cmd: unknown, sub: "route" | "sync"): boolean {
  if (typeof cmd !== "string") return false;
  const tail = cmd.trimEnd();
  if (!tail.endsWith(` ${sub}`) && tail !== `metaskill ${sub}`) return false;
  return /metaskill|meta-skill|cli\.js/.test(cmd);
}

function upsert(groups: HookGroup[], sub: "route" | "sync", matcher: string | undefined, timeout: number): void {
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (isMetaskillHookCommand(h.command, sub)) {
        h.command = hookCommand(sub); // refresh path and timeout on re-init
        h.timeout = timeout;
        return;
      }
    }
  }
  const entry: HookGroup = { hooks: [{ type: "command", command: hookCommand(sub), timeout }] };
  if (matcher) entry.matcher = matcher;
  groups.push(entry);
}

// Adds our two hooks without touching anything else in settings.json.
// Idempotent: re-running refreshes the command path instead of duplicating.
export function addHooks(settings: Settings): Settings {
  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  // UserPromptSubmit supports no matcher (verified against current docs).
  // 90s, not the 30s default: worst case is discovery (10s) + scan + 20s
  // install — a 30s kill can land after the install but before the log line.
  upsert(settings.hooks.UserPromptSubmit, "route", undefined, 90);
  settings.hooks.SessionStart ??= [];
  upsert(settings.hooks.SessionStart, "sync", "startup|resume", 60);
  return settings;
}

export function removeHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  for (const event of ["UserPromptSubmit", "SessionStart"] as const) {
    const groups = settings.hooks[event];
    if (!groups) continue;
    for (const g of groups) {
      g.hooks = (g.hooks ?? []).filter(
        (h) => !isMetaskillHookCommand(h.command, "route") && !isMetaskillHookCommand(h.command, "sync"),
      );
    }
    settings.hooks[event] = groups.filter((g) => (g.hooks ?? []).length > 0);
    if (settings.hooks[event]!.length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}
