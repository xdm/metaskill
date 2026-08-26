// Fixed domain taxonomy (spec 4.7). The LLM classifier may only return IDs
// from this list; anything else is dropped by validation.

export interface DomainDef {
  id: string;
  // Matching rules (heuristics): single ASCII tokens match on word boundary,
  // phrases and non-ASCII keywords match as substrings. All lowercase.
  keywords: string[];
  extensions: string[]; // file extensions without the dot
  query: string; // what we pass to `skills find`
  deps?: string[]; // package.json dep names that imply this domain (stack)
  files?: string[]; // marker files in cwd that imply this domain (stack)
  stackPriority?: number; // higher = more specific when merging stack domains
}

export const TAXONOMY: DomainDef[] = [
  { id: "xlsx", keywords: ["xlsx", "excel", "spreadsheet", "workbook", "pivot table"], extensions: ["xlsx", "xlsm", "xls"], query: "xlsx" },
  { id: "docx", keywords: ["docx", "word document", "word doc", "word file"], extensions: ["docx", "doc"], query: "docx" },
  { id: "pptx", keywords: ["pptx", "powerpoint", "slide deck", "slides deck"], extensions: ["pptx", "ppt"], query: "pptx" },
  { id: "pdf", keywords: ["pdf"], extensions: ["pdf"], query: "pdf" },
  { id: "python", keywords: ["python", "flask", "django", "fastapi", "pip install", "virtualenv"], extensions: ["py", "ipynb"], query: "python", files: ["requirements.txt", "pyproject.toml", "setup.py"], stackPriority: 60 },
  { id: "typescript", keywords: ["typescript", "tsconfig"], extensions: ["ts", "tsx"], query: "typescript", deps: ["typescript"], stackPriority: 60 },
  { id: "react", keywords: ["react", "jsx", "usestate", "useeffect"], extensions: ["jsx", "tsx"], query: "react", deps: ["react"], stackPriority: 70 },
  { id: "nextjs", keywords: ["nextjs", "next.js", "app router", "getserversideprops", "vercel deploy"], extensions: [], query: "nextjs", deps: ["next"], stackPriority: 80 },
  { id: "node", keywords: ["node.js", "nodejs", "npm", "pnpm", "express"], extensions: ["mjs", "cjs"], query: "nodejs", files: ["package.json"], stackPriority: 40 },
  { id: "docker", keywords: ["docker", "dockerfile", "docker-compose", "docker compose", "containerize", "container image"], extensions: [], query: "docker", files: ["Dockerfile", "docker-compose.yml", "compose.yaml"], stackPriority: 30 },
  { id: "linux-admin", keywords: ["systemd", "cron", "crontab", "nginx", "iptables", "journalctl", "ssh config", "ubuntu server", "bash script"], extensions: [], query: "linux" },
  { id: "postgres", keywords: ["postgres", "postgresql", "psql", "pg_dump"], extensions: [], query: "postgres", deps: ["pg", "postgres"], stackPriority: 50 },
  { id: "mysql", keywords: ["mysql", "mariadb"], extensions: [], query: "mysql", deps: ["mysql", "mysql2"], stackPriority: 50 },
  { id: "firebase", keywords: ["firebase", "firestore", "cloud function"], extensions: [], query: "firebase", deps: ["firebase", "firebase-admin"], stackPriority: 70 },
  { id: "algolia", keywords: ["algolia"], extensions: [], query: "algolia", deps: ["algoliasearch"], stackPriority: 70 },
  { id: "git", keywords: ["git rebase", "git merge", "git history", "gitignore", "cherry-pick", "git bisect", "squash"], extensions: [], query: "git" },
  { id: "debugging", keywords: ["debug", "debugging", "stack trace", "traceback", "segfault", "root cause", "crash", "crashes", "reproduce the bug", "bug"], extensions: [], query: "debugging" },
  { id: "code-review", keywords: ["code review", "review this pr", "review the pr", "pull request", "review my code", "review the code"], extensions: [], query: "code review" },
  { id: "documentation", keywords: ["readme", "api docs", "docstring", "changelog", "write documentation", "document the code", "jsdoc"], extensions: [], query: "documentation" },
  { id: "testing", keywords: ["unit test", "unit tests", "e2e test", "test coverage", "jest", "vitest", "pytest", "tdd", "run tests", "write tests"], extensions: [], query: "testing" },
  { id: "ci", keywords: ["github actions", "gitlab ci", "ci pipeline", "ci/cd", "continuous integration"], extensions: [], query: "github actions" },
  { id: "security-review", keywords: ["security review", "security audit", "vulnerability", "vulnerabilities", "sql injection", "xss", "csrf", "pentest"], extensions: [], query: "security review" },
  { id: "frontend-design", keywords: ["css", "tailwind", "ui design", "landing page", "layout", "animation", "design system"], extensions: ["css", "scss"], query: "frontend design" },
  { id: "api-design", keywords: ["rest api", "graphql", "openapi", "swagger", "api endpoint", "api design", "webhook"], extensions: [], query: "api design" },
  { id: "data-analysis", keywords: ["analyze data", "data analysis", "dataframe", "pandas", "dataset", "statistics", "plot"], extensions: ["csv", "parquet"], query: "data analysis" },
  { id: "scraping", keywords: ["scrape", "scraping", "crawl", "crawler", "beautifulsoup", "scrape linkedin"], extensions: [], query: "web scraping" },
  { id: "browser-automation", keywords: ["playwright", "puppeteer", "selenium", "browser automation", "automate the browser"], extensions: [], query: "browser automation" },
  { id: "copywriting", keywords: ["copywriting", "marketing copy", "headline", "tagline", "ad copy", "product copy", "linkedin post", "social media post", "social post", "blog post", "reddit post", "tweet"], extensions: [], query: "copywriting" },
  { id: "seo", keywords: ["seo", "meta tags", "meta description", "sitemap", "search ranking"], extensions: [], query: "seo" },
  { id: "i18n", keywords: ["i18n", "internationalization", "localization", "locale", "translate the app"], extensions: [], query: "i18n" },
  { id: "game-design", keywords: ["game design", "game mechanics", "gameplay", "level design", "roguelike", "godot"], extensions: [], query: "game design" },
  { id: "email", keywords: ["email template", "newsletter", "smtp", "dkim", "spf record", "mjml", "transactional email"], extensions: [], query: "email" },
  // Platform work (posting, automation) — distinct from writing the copy,
  // which stays in `copywriting`. Bare platform names are deliberately NOT
  // keywords: "write a linkedin post" is a writing task.
  { id: "social-media", keywords: ["post to reddit", "post to linkedin", "post to twitter", "post to instagram", "schedule posts", "social media automation", "cross-post", "subreddit"], extensions: [], query: "social media" },
];

export const DOMAIN_IDS: ReadonlySet<string> = new Set(TAXONOMY.map((d) => d.id));

export function isDomain(s: string): boolean {
  return DOMAIN_IDS.has(s);
}

export function getDomain(id: string): DomainDef | undefined {
  return TAXONOMY.find((d) => d.id === id);
}

// Users extend the taxonomy from metaskill.yaml (custom_domains) without
// forking: a custom entry with a known id replaces the built-in (lets users
// fix a query or keywords), a new id appends a new domain.
export function mergedTaxonomy(custom: DomainDef[]): DomainDef[] {
  if (!custom.length) return TAXONOMY;
  const byId = new Map(TAXONOMY.map((d) => [d.id, d]));
  for (const c of custom) byId.set(c.id, c);
  return [...byId.values()];
}
