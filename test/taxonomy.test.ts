import { describe, expect, it } from "vitest";
import { DOMAIN_IDS, TAXONOMY, isDomain } from "../src/taxonomy.js";

// Spec 4.7 — the fixed v1 domain list.
const SPEC_DOMAINS = [
  "xlsx", "docx", "pptx", "pdf", "python", "typescript", "react", "nextjs",
  "node", "docker", "linux-admin", "postgres", "mysql", "firebase", "algolia",
  "git", "testing", "ci", "security-review", "frontend-design", "api-design",
  "data-analysis", "scraping", "browser-automation", "bitrix24", "copywriting",
  "seo", "i18n", "game-design", "email",
];

describe("taxonomy", () => {
  it("contains exactly the spec 4.7 domains", () => {
    expect([...DOMAIN_IDS].sort()).toEqual([...SPEC_DOMAINS].sort());
  });

  it("has unique ids and a search query for every domain", () => {
    const ids = TAXONOMY.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of TAXONOMY) {
      expect(d.query.length, `query for ${d.id}`).toBeGreaterThan(0);
      expect(d.keywords.length, `keywords for ${d.id}`).toBeGreaterThan(0);
    }
  });

  it("validates domain ids", () => {
    expect(isDomain("xlsx")).toBe(true);
    expect(isDomain("blockchain")).toBe(false);
  });
});
