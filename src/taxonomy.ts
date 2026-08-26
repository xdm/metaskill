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
  { id: "python", keywords: ["python", "flask", "django", "fastapi", "pip install", "virtualenv", "питон"], extensions: ["py", "ipynb"], query: "python", files: ["requirements.txt", "pyproject.toml", "setup.py"], stackPriority: 60 },
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
  { id: "testing", keywords: ["unit test", "unit tests", "e2e test", "test coverage", "jest", "vitest", "pytest", "tdd", "run tests", "write tests", "тесты"], extensions: [], query: "testing" },
  { id: "ci", keywords: ["github actions", "gitlab ci", "ci pipeline", "ci/cd", "continuous integration"], extensions: [], query: "ci cd pipeline" },
  { id: "security-review", keywords: ["security review", "security audit", "vulnerability", "vulnerabilities", "sql injection", "xss", "csrf", "pentest"], extensions: [], query: "security review" },
  { id: "frontend-design", keywords: ["css", "tailwind", "ui design", "landing page", "layout", "animation", "design system", "вёрстка", "верстка"], extensions: ["css", "scss"], query: "frontend design" },
  { id: "api-design", keywords: ["rest api", "graphql", "openapi", "swagger", "api endpoint", "api design", "webhook"], extensions: [], query: "api design" },
  { id: "data-analysis", keywords: ["analyze data", "data analysis", "dataframe", "pandas", "dataset", "statistics", "plot", "визуализируй"], extensions: ["csv", "parquet"], query: "data analysis" },
  { id: "scraping", keywords: ["scrape", "scraping", "crawl", "crawler", "beautifulsoup", "спарси", "парсинг сайта"], extensions: [], query: "web scraping" },
  { id: "browser-automation", keywords: ["playwright", "puppeteer", "selenium", "browser automation", "automate the browser"], extensions: [], query: "browser automation" },
  { id: "bitrix24", keywords: ["bitrix24", "bitrix", "битрикс"], extensions: [], query: "bitrix24" },
  { id: "copywriting", keywords: ["copywriting", "marketing copy", "headline", "tagline", "ad copy", "product copy", "заголовок", "оффер"], extensions: [], query: "copywriting" },
  { id: "seo", keywords: ["seo", "meta tags", "meta description", "sitemap", "search ranking"], extensions: [], query: "seo" },
  { id: "i18n", keywords: ["i18n", "internationalization", "localization", "locale", "translate the app", "локализация"], extensions: [], query: "i18n localization" },
  { id: "game-design", keywords: ["game design", "game mechanics", "gameplay", "level design", "roguelike", "godot", "геймдизайн"], extensions: [], query: "game design" },
  { id: "email", keywords: ["email template", "newsletter", "smtp", "dkim", "spf record", "mjml", "transactional email", "рассылка"], extensions: [], query: "email" },
];

export const DOMAIN_IDS: ReadonlySet<string> = new Set(TAXONOMY.map((d) => d.id));

export function isDomain(s: string): boolean {
  return DOMAIN_IDS.has(s);
}

export function getDomain(id: string): DomainDef | undefined {
  return TAXONOMY.find((d) => d.id === id);
}
