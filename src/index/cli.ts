import fs from "node:fs";
import path from "node:path";
import { buildIndex } from "./build.js";

// CI entry point. Not part of the `metaskill` CLI: users never build an index,
// they download one.
async function main(): Promise<number> {
  const out = process.argv[2] ?? "index.json";
  const started = Date.now();
  // Without a token the GitHub API allows 60 calls an hour, which is fewer
  // than the repository count; CI always supplies one.
  const index = await buildIndex({
    token: process.env.GITHUB_TOKEN,
    onProgress: (m) => process.stderr.write(`${m}\n`),
  });

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index) + "\n");

  const dirty = index.skills.filter((s) => s.scan === "dirty").length;
  const estimated = index.skills.filter((s) => s.estimated).length;
  process.stdout.write(
    `${out}: ${index.skillCount} skills, ${index.repoCount} repos, ` +
      `${estimated} estimated, ${dirty} dirty, ${Math.round((Date.now() - started) / 1000)}s\n`,
  );
  return index.skillCount > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`index build failed: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
