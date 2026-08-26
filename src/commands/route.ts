import { readCache } from "../cache.js";
import { classifyHeuristic } from "../classify/heuristics.js";
import { classifyLlm } from "../classify/llm.js";
import { buildContext, type RouteReport } from "../context.js";
import { discover, publisherOf } from "../discover.js";
import { installSkill } from "../install.js";
import { coverage, listInstalledSkills } from "../inventory.js";
import { appendLog, hashPrompt } from "../log.js";
import { decide, loadPolicy } from "../policy.js";
import { scanCandidate } from "../scan.js";
import { getDomain } from "../taxonomy.js";
import type { Candidate, DiscoveredLogItem, ScanResult } from "../types.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string; // older Claude Code builds
  user_prompt?: string; // current builds
  user_prompt_raw?: string;
}

function emit(context: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
    }) + "\n",
  );
}

// UserPromptSubmit hook body (spec 4.2). Hard rule: never break the user's
// prompt — every failure path logs to stderr and exits 0 with no output.
export async function routeCommand(stdinText: string): Promise<number> {
  const t0 = Date.now();
  try {
    let input: HookInput;
    try {
      input = JSON.parse(stdinText || "{}") as HookInput;
    } catch {
      return 0;
    }
    const prompt = input.user_prompt ?? input.prompt ?? input.user_prompt_raw ?? "";
    const cwd = input.cwd ?? process.cwd();
    const session = input.session_id ?? "";
    if (!prompt.trim()) return 0;

    const policy = loadPolicy();

    // 1-2: triviality + classification (heuristics, then LLM per policy)
    const h = classifyHeuristic(prompt, cwd, policy.classifier.trivialMaxChars);
    let domains = [...h.domains];
    let trivial = h.trivial;
    let llmUsed = false;
    const wantLlm =
      policy.classifier.llm === "always" ||
      (policy.classifier.llm === "auto" && !trivial && h.confidence !== "high");
    if (wantLlm) {
      const r = await classifyLlm(prompt, h.stackDomains, policy.classifier.model);
      if (r) {
        llmUsed = true;
        trivial = trivial || (r.trivial && domains.length === 0 && r.domains.length === 0);
        domains = [...new Set([...domains, ...r.domains])].slice(0, 4);
      }
    }
    if (trivial || domains.length === 0) return 0;

    // 3: inventory
    const installed = listInstalledSkills(cwd);
    const cache = readCache();
    const cov = coverage(domains, installed, policy, cache);

    const report: RouteReport = {
      domains,
      installedNow: [],
      present: Object.entries(cov.covered).map(([domain, skill]) => ({ domain, skill })),
      ask: [],
      denied: 0,
    };
    const discoveredLog: DiscoveredLogItem[] = [];
    const installedPkgs: string[] = [];

    // 4-6: discovery -> policy(+scan) -> auto-install, per uncovered domain
    for (const domainId of cov.uncovered) {
      const def = getDomain(domainId);
      if (!def) continue;

      let candidate: Candidate | null = null;
      const override = policy.domains[domainId];
      if (override) {
        candidate = {
          pkg: override,
          publisher: publisherOf(override),
          skillName: override.slice(override.lastIndexOf("@") + 1),
          installs: 0,
          url: "",
        };
      } else {
        const cands = await discover(def);
        if (cands.length) candidate = [...cands].sort((a, b) => b.installs - a.installs)[0]!;
      }
      if (!candidate) continue; // coverage gap — visible in the log as a domain with no discovery

      let scan: ScanResult = { status: "skipped", findings: [] };
      const pub = candidate.publisher;
      if (!policy.trust.allowlist.includes(pub) && !policy.trust.denyPublishers.includes(pub)) {
        scan = await scanCandidate(candidate, policy);
      }

      let verdict = decide(candidate, scan, policy);
      if (verdict.decision === "auto") {
        const res = await installSkill(candidate.pkg, domainId);
        if (res.ok) {
          report.installedNow.push({ pkg: candidate.pkg, version: res.version, path: res.skillMdPath });
          installedPkgs.push(candidate.pkg);
        } else {
          // spec 4.2.6: install timeout downgrades the candidate to ask
          verdict = { decision: "ask", reason: res.timedOut ? "install timed out" : "install failed" };
          report.ask.push({
            candidate,
            reason: `${verdict.reason} — run \`metaskill install ${candidate.pkg} --force\``,
          });
        }
      } else if (verdict.decision === "ask") {
        report.ask.push({ candidate, reason: verdict.reason });
      } else {
        report.denied++;
      }
      discoveredLog.push({
        pkg: candidate.pkg,
        installs: candidate.installs,
        publisher: pub,
        decision: verdict.decision,
        scan: scan.status,
      });
    }

    // 7: context out
    const ctx = buildContext(report);
    if (ctx) emit(ctx);

    // 8: log (hash only, never the prompt — spec 4.6)
    appendLog(
      {
        ts: new Date().toISOString(),
        session,
        prompt_hash: hashPrompt(prompt),
        domains,
        covered: Object.keys(cov.covered),
        discovered: discoveredLog,
        installed: installedPkgs,
        latency_ms: Date.now() - t0,
        llm_used: llmUsed,
      },
      policy,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[metaskill] route error: ${(err as Error).message}\n`);
    return 0;
  }
}
