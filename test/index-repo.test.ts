import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchRepoArchive, fetchRepoMeta, fetchSkillsViaTree, findSkillDirs } from "../src/index/repo.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-repo-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A repo whose directory name and frontmatter name deliberately disagree —
// this is the real vercel-labs/agent-skills layout and the reason the indexer
// reads names from frontmatter instead of paths.
function makeRepo(): string {
  const root = path.join(tmp, "repo-HEAD");
  fs.mkdirSync(path.join(root, "skills", "react-best-practices"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "react-best-practices", "SKILL.md"),
    "---\nname: vercel-react-best-practices\ndescription: React and Next.js performance guidelines.\nlicense: MIT\n---\n\nBody.\n",
  );
  fs.mkdirSync(path.join(root, ".github", "skills", "other"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "skills", "other", "SKILL.md"),
    "---\nname: other\ndescription: Another one.\n---\n",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  return root;
}

function tarball(root: string): Buffer {
  const out = path.join(tmp, "a.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", path.dirname(root), path.basename(root)]);
  return fs.readFileSync(out);
}

describe("findSkillDirs", () => {
  it("reads name and description from frontmatter, not from the directory name", () => {
    const skills = findSkillDirs(makeRepo());
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["other", "vercel-react-best-practices"]);
    expect(byName["vercel-react-best-practices"]!.rel).toBe("skills/react-best-practices");
    expect(byName["vercel-react-best-practices"]!.description).toContain("Next.js performance");
    expect(byName["vercel-react-best-practices"]!.license).toBe("MIT");
  });

  it("skips SKILL.md files with no name in frontmatter", () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, "broken"), { recursive: true });
    fs.writeFileSync(path.join(root, "broken", "SKILL.md"), "no frontmatter here\n");
    expect(findSkillDirs(root)).toHaveLength(2);
  });
});

describe("fetchRepoArchive", () => {
  it("downloads, extracts, and exposes the repo root", async () => {
    const body = tarball(makeRepo());
    const fetchImpl = (async () => ({
      ok: true,
      body: (async function* () {
        yield new Uint8Array(body);
      })(),
    })) as unknown as typeof fetch;

    const snap = await fetchRepoArchive("owner/repo", { fetchImpl, tmpBase: tmp });
    expect(snap).not.toBeNull();
    expect(findSkillDirs(snap!.root)).toHaveLength(2);
    snap!.cleanup();
  });

  it("returns null when the archive exceeds the download cap", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      body: (async function* () {
        yield new Uint8Array(1024);
        yield new Uint8Array(1024);
      })(),
    })) as unknown as typeof fetch;

    const snap = await fetchRepoArchive("owner/repo", { fetchImpl, tmpBase: tmp, maxDownloadBytes: 1500 });
    expect(snap).toBeNull();
  });

  it("returns null on a failed download", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, body: null })) as unknown as typeof fetch;
    expect(await fetchRepoArchive("owner/gone", { fetchImpl, tmpBase: tmp })).toBeNull();
  });
});

describe("fetchRepoMeta", () => {
  it("reads stars and the pushed date, trimmed to a day", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ stargazers_count: 1423, pushed_at: "2026-08-26T09:12:31Z" }),
    })) as unknown as typeof fetch;

    expect(await fetchRepoMeta("microsoft/azure-skills", { fetchImpl })).toEqual({
      stars: 1423,
      pushedAt: "2026-08-26",
    });
  });

  it("returns an empty object rather than throwing when the call fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("rate limited");
    }) as unknown as typeof fetch;
    expect(await fetchRepoMeta("o/r", { fetchImpl })).toEqual({});
  });
});

describe("fetchSkillsViaTree", () => {
  it("lists SKILL.md paths and reads names from raw frontmatter", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return {
          ok: true,
          json: async () => ({
            truncated: false,
            tree: [
              { path: "README.md" },
              { path: "skills/react-best-practices/SKILL.md" },
              { path: "skills/other/SKILL.md" },
            ],
          }),
        } as unknown as Response;
      }
      const name = u.includes("react-best-practices") ? "vercel-react-best-practices" : "other";
      return {
        ok: true,
        text: async () => `---\nname: ${name}\ndescription: about ${name}\n---\n`,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await fetchSkillsViaTree("vercel-labs/agent-skills", { fetchImpl });
    expect(out.map((s) => s.name).sort()).toEqual(["other", "vercel-react-best-practices"]);
    expect(out.find((s) => s.name === "other")!.rel).toBe("skills/other");
  });

  it("matches SKILL.md by basename, not by any path ending in the string \"SKILL.md\"", async () => {
    const rawCalls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return {
          ok: true,
          json: async () => ({
            truncated: false,
            tree: [{ path: "docs/NOT_A_SKILL.md" }, { path: "skills/real/SKILL.md" }],
          }),
        } as unknown as Response;
      }
      rawCalls.push(u);
      const name = u.includes("NOT_A_SKILL") ? "decoy" : "real";
      return {
        ok: true,
        text: async () => `---\nname: ${name}\ndescription: about ${name}\n---\n`,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const out = await fetchSkillsViaTree("owner/repo", { fetchImpl });
    expect(out.map((s) => s.name)).toEqual(["real"]);
    expect(rawCalls.some((u) => u.includes("NOT_A_SKILL"))).toBe(false);
  });

  it("returns [] when the tree call fails", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    expect(await fetchSkillsViaTree("o/gone", { fetchImpl })).toEqual([]);
  });

  it("returns [] on a truncated tree instead of the partial SKILL.md list it found", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("/git/trees/")) {
        return {
          ok: true,
          json: async () => ({ truncated: true, tree: [{ path: "skills/real/SKILL.md" }] }),
        } as unknown as Response;
      }
      throw new Error("must not fetch raw content off a truncated tree");
    }) as unknown as typeof fetch;

    expect(await fetchSkillsViaTree("o/big", { fetchImpl })).toEqual([]);
  });
});
