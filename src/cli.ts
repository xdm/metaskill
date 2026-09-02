import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "./paths.js";

const HELP = `metaskill — Claude Code installs the skills a task needs, before solving it.

Usage: metaskill <command> [options]

Commands:
  init [--project] [--uninstall]   Register/remove Claude Code hooks, policy, SKILL.md
  route                            UserPromptSubmit hook body (stdin JSON): logs the prompt
  find "<words>"   find a skill for a capability
  sync [--force]                   SessionStart hook body: daily update of allowlisted skills
  install <pkg> [--force] [--matched "<phrase>"]  Install one skill through policy + scan
  update [names...] [--force]      Update installed skills (allowlist without --force)
  list                             Show what metaskill has installed (alias: ls)
  plugins [words]                  Search Claude Code plugin marketplaces (suggest only)
  log [-n N] [--stats]             Show recent routing decisions, or find follow-through

Files: ~/.metaskill/{metaskill.yaml,cache.json,skills-lock.json,log.jsonl}
`;

interface Args {
  flags: Record<string, string | boolean>;
  pos: string[];
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--index" || a === "-n" || a === "--matched") {
      flags[a === "-n" ? "n" : a.slice(2)] = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = true;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);

  switch (cmd) {
    case "init": {
      const { initCommand } = await import("./commands/init.js");
      return initCommand({
        project: flags.project === true,
        uninstall: flags.uninstall === true,
        force: flags.force === true,
      });
    }
    case "route": {
      const { routeCommand } = await import("./commands/route.js");
      return routeCommand(await readStdin());
    }
    case "find": {
      const { findCommand } = await import("./commands/find.js");
      return findCommand(pos.join(" "), { index: typeof flags.index === "string" ? flags.index : undefined });
    }
    case "sync": {
      const { syncCommand } = await import("./commands/sync.js");
      return syncCommand({ force: flags.force === true });
    }
    case "install": {
      const { installCommand } = await import("./commands/install.js");
      return installCommand(pos[0], {
        force: flags.force === true,
        matched: typeof flags.matched === "string" ? flags.matched : undefined,
      });
    }
    case "update": {
      const { updateCommand } = await import("./commands/update.js");
      return updateCommand(pos, { force: flags.force === true });
    }
    case "plugins": {
      const { pluginsCommand } = await import("./commands/plugins.js");
      return pluginsCommand(pos);
    }
    case "list":
    case "ls": {
      const { listCommand } = await import("./commands/list.js");
      return listCommand();
    }
    case "log": {
      const { logCommand } = await import("./commands/log.js");
      const n = typeof flags.n === "string" ? parseInt(flags.n, 10) || 20 : 20;
      return logCommand(n, { stats: flags.stats === true });
    }
    case "--version":
    case "-v":
      process.stdout.write(version() + "\n");
      return 0;
    case undefined:
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`metaskill: unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`metaskill: ${(err as Error).stack ?? err}\n`);
    // Hooks must never hard-fail the prompt; other commands report failure.
    process.exit(process.argv[2] === "route" || process.argv[2] === "sync" ? 0 : 1);
  },
);
