#!/usr/bin/env node
// Fake `skills` CLI for tests. Selected via METASKILL_SKILLS_CMD so the real
// npx/network path is never hit. Records every invocation to $STUB_LOG.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME ?? os.homedir();

if (process.env.STUB_LOG) {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + "\n");
}

const FIND_FIXTURES = {
  xlsx: `
Install with npx skills add <owner/repo@skill>

anthropics/skills@xlsx 158.3K installs
└ https://skills.sh/anthropics/skills/xlsx

claude-office-skills/skills@xlsx-manipulation 5.3K installs
└ https://skills.sh/claude-office-skills/skills/xlsx-manipulation
`,
  nodejs: `
Install with npx skills add <owner/repo@skill>

modelscope.cn@node-helper 410 installs
└ https://skills.sh/modelscope.cn/node-helper
`,
  reddit: `
Install with npx skills add <owner/repo@skill>

modelscope.cn@reddit-helper 146.1K installs
└ https://skills.sh/modelscope.cn/reddit-helper
`,
};

function writeSkill(skill, version) {
  const agentsDir = path.join(home, ".agents", "skills", skill);
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: stub skill for ${skill}\nversion: ${version}\n---\n\n# ${skill}\n`,
  );
  const claudeDir = path.join(home, ".claude", "skills");
  fs.mkdirSync(claudeDir, { recursive: true });
  const link = path.join(claudeDir, skill);
  try {
    fs.symlinkSync(agentsDir, link);
  } catch {
    /* already linked */
  }
}

const cmd = args[0];

if (cmd === "--version") {
  console.log("1.5.23-stub");
  process.exit(0);
}

if (cmd === "find") {
  if (process.env.STUB_FIND_EMPTY === "1") process.exit(0);
  const query = args[1] ?? "";
  const key = Object.keys(FIND_FIXTURES).find((k) => query.includes(k));
  process.stdout.write(key ? FIND_FIXTURES[key] : "");
  process.exit(0);
}

if (cmd === "add") {
  const sleep = Number(process.env.STUB_ADD_SLEEP_MS ?? 0);
  const finish = () => {
    if (process.env.STUB_ADD_FAIL === "1") {
      console.error("stub: add failed");
      process.exit(1);
    }
    const pkg = args[1] ?? "";
    const skill = pkg.slice(pkg.lastIndexOf("@") + 1);
    writeSkill(skill, "1.2.3");
    console.log(`stub: added ${pkg}`);
    process.exit(0);
  };
  if (sleep > 0) setTimeout(finish, sleep);
  else finish();
}

if (cmd === "update") {
  const names = args.slice(1).filter((a) => !a.startsWith("-"));
  for (const skill of names) {
    writeSkill(skill, process.env.STUB_UPDATE_VERSION ?? "1.2.4");
  }
  console.log(`stub: updated ${names.join(", ")}`);
  process.exit(0);
}
