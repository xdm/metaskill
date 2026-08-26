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

  it("triviality is structural: short + zero domain signals", () => {
    for (const p of ["refactor the user service", "fix that thing", "sounds good, ship it"]) {
      expect(classifyHeuristic(p, emptyDir, 40).trivial, p).toBe(true);
    }
    // one domain signal rescues a short prompt
    expect(classifyHeuristic("fix the dockerfile", emptyDir, 40).trivial).toBe(false);
  });
});

describe("heuristics: unclassifiable prompts", () => {
  // No wordlists exist beyond the domain keywords, so any prompt without a
  // domain signal — whatever the language — must yield zero domains WITHOUT
  // being trivial once it is long enough, handing classification to the
  // in-session model.
  it("long prompts with no domain signal go to the model-side fallback", () => {
    for (const prompt of [
      "find the supplier websites with their staff and put together an overview",
      "gather the company contacts into one list and prepare a clean export",
    ]) {
      const r = classifyHeuristic(prompt, emptyDir, 40);
      expect(r.domains, prompt).toEqual([]);
      expect(r.trivial, prompt).toBe(false);
    }
  });

  it("short smalltalk stays trivial (no fallback noise)", () => {
    for (const p of ["hi there", "thanks a lot!", "ok cool"]) {
      expect(classifyHeuristic(p, emptyDir, 40).trivial, p).toBe(true);
    }
  });
});

describe("heuristics: custom domains (policy custom_domains)", () => {
  it("classifies against the merged taxonomy, and custom entries can replace built-ins", async () => {
    const { mergedTaxonomy } = await import("../src/taxonomy.js");
    const merged = mergedTaxonomy([
      { id: "wordpress", keywords: ["wordpress", "woocommerce"], extensions: [], query: "wordpress" },
    ]);
    const r = classifyHeuristic("fix the wordpress theme after the plugin update", emptyDir, 40, merged);
    expect(r.domains).toContain("wordpress");
    // replacing a built-in id swaps its keywords
    const replaced = mergedTaxonomy([{ id: "seo", keywords: ["positioning"], extensions: [], query: "seo" }]);
    expect(classifyHeuristic("improve seo and add meta tags", emptyDir, 40, replaced).domains).not.toContain("seo");
    expect(classifyHeuristic("work on the positioning statement", emptyDir, 40, replaced).domains).toContain("seo");
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
