import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyHeuristic, detectStack } from "../src/classify/heuristics.js";
import { PROMPT_CASES } from "./fixtures/prompts.js";

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-empty-"));
afterAll(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

describe("heuristics: 40-prompt reference set (spec §6)", () => {
  it("micro-precision >= 0.9 and micro-recall >= 0.8 on obvious prompts", () => {
    let tp = 0;
    let predicted = 0;
    let expected = 0;
    const failures: string[] = [];
    for (const c of PROMPT_CASES.filter((c) => c.obvious && !c.trivial)) {
      const r = classifyHeuristic(c.prompt, emptyDir, 40);
      const pred = new Set(r.domains);
      const exp = new Set(c.expect);
      predicted += pred.size;
      expected += exp.size;
      const hit = [...pred].filter((d) => exp.has(d)).length;
      tp += hit;
      if (hit < pred.size || hit < exp.size) {
        failures.push(`"${c.prompt}" -> [${r.domains.join(",")}], expected [${c.expect.join(",")}]`);
      }
    }
    const precision = predicted ? tp / predicted : 1;
    const recall = expected ? tp / expected : 1;
    expect(precision, `precision ${precision.toFixed(2)}\n${failures.join("\n")}`).toBeGreaterThanOrEqual(0.9);
    expect(recall, `recall ${recall.toFixed(2)}\n${failures.join("\n")}`).toBeGreaterThanOrEqual(0.8);
  });

  it("flags trivial prompts and never returns domains for them", () => {
    for (const c of PROMPT_CASES.filter((c) => c.trivial)) {
      const r = classifyHeuristic(c.prompt, emptyDir, 40);
      expect(r.trivial, `"${c.prompt}" should be trivial`).toBe(true);
      expect(r.domains).toEqual([]);
    }
  });

  it("does not flag short action prompts as trivial", () => {
    const r = classifyHeuristic("refactor the user service", emptyDir, 40);
    expect(r.trivial).toBe(false);
    expect(r.confidence).toBe("low"); // no domain hit -> LLM territory
  });
});

describe("heuristics: project stack", () => {
  it("detects node/typescript/react/nextjs from package.json and python/docker from files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-stack-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "^18", next: "14.0.0" }, devDependencies: { typescript: "^5" } }),
    );
    fs.writeFileSync(path.join(dir, "requirements.txt"), "pandas\n");
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:20\n");
    const stack = detectStack(dir);
    expect(new Set(stack)).toEqual(new Set(["node", "typescript", "react", "nextjs", "python", "docker"]));
    // most specific first
    expect(stack[0]).toBe("nextjs");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("merges at most 2 stack domains, and only when the prompt itself matched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metaskill-stack2-"));
    fs.writeFileSync(path.join(dir, "requirements.txt"), "openpyxl\n");
    // spec §2 example: xlsx from prompt + python from stack
    const withSubject = classifyHeuristic("export the report to xlsx with formulas", dir, 40);
    expect(withSubject.domains).toContain("xlsx");
    expect(withSubject.domains).toContain("python");
    // no prompt-derived domain -> stack alone must not trigger
    const noSubject = classifyHeuristic("please summarize what changed in the last release notes", dir, 40);
    expect(noSubject.domains).toEqual([]);
    expect(noSubject.stackDomains).toContain("python");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
