import type { IndexRecord } from "./types.js";

// The registry is one part skills and one part copies of them. Two aggregator
// repositories alone mirror ~12,800 skills from hundreds of origins, and a
// popular repository is forked whole several times over — so the same skill,
// same name and same description, appears under five or six package names.
// Measured on the 2026-09-21 index: 11,818 of 44,573 records are such copies.
// Ranked, they stack: a query for "linkedin content" returns the same skill
// five times, and the row the user is asked about is whichever copy the
// tokeniser happened to favour, not the one people install.
//
// One record per skill. Identity is the name plus the description, compared
// loosely (case, whitespace); a record with no description has no identity
// to compare and is always kept. Which copy survives:
//
//   1. The one with the higher real install count. It is the honest evidence
//      of which copy people use, and it is what keeps a popular origin
//      intact: anthropics/skills is mirrored by 21 repositories, and any
//      rule that read "many partners" as "mirror" dropped 8 of its 20
//      skills. Measured on the 2026-09-21 index, installs-first keeps
//      anthropics/skills 20/20 and obra/superpowers 15/15.
//   2. Among copies nobody is known to install, the one from the repository
//      that shares skills with the FEWEST other repositories. An aggregator
//      shares with hundreds (aiskillstore/marketplace: 216); a small origin
//      shares with the two or three that copied it.
//   3. Then the source name, so the outcome never depends on sweep order.
//
// A copy people install from an aggregator can therefore outlive its
// unknown origin. That is the evidence-based outcome, and policy reads the
// same on both (no clean scan on either, so `ask`). What this drops is only
// ever a copy: every skill dropped is, by name and description, still in
// the index. Measured effect on the 57 real queries of 2026-09-08..21: top
// rows from the two aggregators fell from 6 to 2, and competitor-profiling
// came back as coreyhaines31/marketingskills (191,700 installs) instead of
// its aiskillstore copy.
export function dedupeIndex(skills: IndexRecord[]): { skills: IndexRecord[]; removed: number } {
  const keyOf = (r: IndexRecord): string | null => {
    const d = (r.description ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    return d ? `${r.name.toLowerCase()} ${d}` : null;
  };

  const groups = new Map<string, IndexRecord[]>();
  const keyed: (string | null)[] = skills.map((r) => {
    const k = keyOf(r);
    if (k) {
      const g = groups.get(k);
      if (g) g.push(r);
      else groups.set(k, [r]);
    }
    return k;
  });

  // partners(source): how many other repositories this one shares at least
  // one identical skill with.
  const partners = new Map<string, Set<string>>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sources = new Set(g.map((r) => r.source));
    for (const s of sources) {
      let set = partners.get(s);
      if (!set) partners.set(s, (set = new Set()));
      for (const o of sources) if (o !== s) set.add(o);
    }
  }
  const partnerCount = (r: IndexRecord): number => partners.get(r.source)?.size ?? 0;

  const survivor = new Map<string, IndexRecord>();
  for (const [k, g] of groups) {
    if (g.length === 1) {
      survivor.set(k, g[0]!);
      continue;
    }
    const best = [...g].sort(
      (a, b) =>
        (b.installs ?? -1) - (a.installs ?? -1) ||
        partnerCount(a) - partnerCount(b) ||
        a.source.localeCompare(b.source),
    )[0]!;
    survivor.set(k, best);
  }

  const out: IndexRecord[] = [];
  for (let i = 0; i < skills.length; i++) {
    const k = keyed[i] ?? null;
    if (k === null || survivor.get(k) === skills[i]) out.push(skills[i]!);
  }
  return { skills: out, removed: skills.length - out.length };
}
