import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "./paths.js";

const HELP = `metaskill — Claude Code installs the skills a task needs, before solving it.

Usage: metaskill <command> [options]

Commands:
  init [--project] [--uninstall]   Register/remove Claude Code hooks, policy, SKILL.md
  route [--domains a,b]            UserPromptSubmit hook body (stdin JSON), or
        [--search "words"]         explicit-domain / free registry search runs
                                   for in-session classification by the model
  find "<words>"   find a skill for a capability
  sync [--force]                   SessionStart hook body: daily update of allowlisted skills
  install <pkg> [--domain d] [--force]   Install one skill through policy + scan
  update [names...] [--force]      Update installed skills (allowlist without --force)
  list                             Show what metaskill has installed (alias: ls)
  plugins [words]                  Search Claude Code plugin marketplaces (suggest only)
  log [-n N]                       Show recent routing decisions

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
    if (a === "--domain" || a === "--domains" || a === "--search" || a === "--index" || a === "-n") {
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
      const domains =
        typeof flags.domains === "string"
          ? flags.domains.split(",").map((d) => d.trim()).filter(Boolean)
          : undefined;
      const search = typeof flags.search === "string" ? flags.search : undefined;
      return routeCommand(domains || search !== undefined ? "" : await readStdin(), { domains, search });
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
        domain: typeof flags.domain === "string" ? flags.domain : undefined,
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
      return logCommand(n);
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
