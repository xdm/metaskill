// Reference prompt set (spec §6, extended as the taxonomy grows). `obvious:
// true` rows form the gate the heuristics alone must clear: micro-precision
// >= 0.9, micro-recall >= 0.8.
// `trivial` rows must short-circuit with no domains.
export interface PromptCase {
  prompt: string;
  expect: string[];
  obvious: boolean;
  trivial?: boolean;
}

export const PROMPT_CASES: PromptCase[] = [
  { prompt: "export the report to xlsx with formulas and conditional formatting", expect: ["xlsx"], obvious: true },
  { prompt: "convert this docx to pdf", expect: ["docx", "pdf"], obvious: true },
  { prompt: "build a pptx deck summarizing q3 results", expect: ["pptx"], obvious: true },
  { prompt: "parse invoices.pdf and extract the totals into a table", expect: ["pdf"], obvious: true },
  { prompt: "write a python script to dedupe entries in users.csv", expect: ["python", "data-analysis"], obvious: true },
  { prompt: "fix the typescript build errors in tsconfig.json", expect: ["typescript"], obvious: true },
  { prompt: "create a react component for the settings page", expect: ["react"], obvious: true },
  { prompt: "migrate our nextjs app to the app router", expect: ["nextjs"], obvious: true },
  { prompt: "why does npm install fail on node 20", expect: ["node"], obvious: true },
  { prompt: "write a dockerfile for the api service", expect: ["docker"], obvious: true },
  { prompt: "set up a cron job and a systemd unit for nightly backups", expect: ["linux-admin"], obvious: true },
  { prompt: "optimize this postgres query, it needs an index", expect: ["postgres"], obvious: true },
  { prompt: "design the mysql schema for orders and payments", expect: ["mysql"], obvious: true },
  { prompt: "add firestore security rules for the chat collection", expect: ["firebase"], obvious: true },
  { prompt: "wire up algolia search on the docs site", expect: ["algolia"], obvious: true },
  { prompt: "interactive git rebase to squash the last 5 commits", expect: ["git"], obvious: true },
  { prompt: "add unit tests with vitest for the parser module", expect: ["testing"], obvious: true },
  { prompt: "set up a github actions pipeline to run tests on every push", expect: ["ci", "testing"], obvious: true },
  { prompt: "do a security review of the auth flow, check for sql injection", expect: ["security-review"], obvious: true },
  { prompt: "polish the landing page css and fix the layout", expect: ["frontend-design"], obvious: true },
  { prompt: "design a rest api with an openapi spec for billing", expect: ["api-design"], obvious: true },
  { prompt: "analyze sales.csv and plot the monthly trend", expect: ["data-analysis"], obvious: true },
  { prompt: "scrape product prices from the competitor site", expect: ["scraping"], obvious: true },
  { prompt: "automate the login flow with playwright", expect: ["browser-automation"], obvious: true },
  { prompt: "debug the github actions workflow that fails on every push", expect: ["ci", "debugging"], obvious: true },
  { prompt: "write marketing copy and a headline for the launch page", expect: ["copywriting"], obvious: true },
  { prompt: "write a linkedin post announcing our product launch", expect: ["copywriting"], obvious: true },
  { prompt: "cross-post the announcement to reddit and schedule posts for next week", expect: ["social-media"], obvious: true },
  { prompt: "improve seo: add meta tags and a sitemap", expect: ["seo"], obvious: true },
  { prompt: "add i18n support with russian and german locales", expect: ["i18n"], obvious: true },
  { prompt: "design game mechanics for the roguelike inventory system", expect: ["game-design"], obvious: true },
  { prompt: "create an email template for the weekly newsletter", expect: ["email"], obvious: true },
  { prompt: "hi", expect: [], obvious: true, trivial: true },
  { prompt: "thanks!", expect: [], obvious: true, trivial: true },
  { prompt: "what does this error mean", expect: [], obvious: true, trivial: true },
  // Short and domain-less -> trivial by the structural rule, any language.
  { prompt: "refactor the user service", expect: [], obvious: true, trivial: true },
  // Rows heuristics can't classify expect []: they are handed to the
  // in-session model via the route --domains flow instead.
  { prompt: "export the crm leads into a table with the totals filled in", expect: [], obvious: true },
  { prompt: "read the pdf, summarize it into a word doc and email it to the team", expect: ["pdf", "docx", "email"], obvious: true },
  { prompt: "the app crashes on startup after updating dependencies", expect: ["debugging"], obvious: true },
  { prompt: "debug the race condition in the checkout worker", expect: ["debugging"], obvious: true },
  { prompt: "review this pull request for the payments module", expect: ["code-review"], obvious: true },
  { prompt: "write a readme and api docs for the sdk", expect: ["documentation"], obvious: true },
  { prompt: "update all copyright headers to 2026", expect: [], obvious: true }, // must NOT over-trigger
  { prompt: "containerize the flask app and deploy it with docker compose", expect: ["docker", "python"], obvious: true },
  { prompt: "write playwright e2e tests for the checkout flow", expect: ["browser-automation", "testing"], obvious: true },
  { prompt: "make our onboarding text friendlier and much shorter", expect: [], obvious: false }, // model-side classification territory
];
