import type { IndexRecord } from "./types.js";

// Aggregator repositories and whole-repo forks carry the same skill — same
// name, same description — under several package names, and ranked they
// stack: one query returns one skill five times. About a quarter of the raw
// index is such copies (DESIGN.md has the numbers).
//
// One record per skill. Identity is name + description, compared loosely; a
// record with no description has no identity to compare and is always kept.
// The copy that survives: the one with the higher real install count (the
// evidence of use, and what keeps a heavily mirrored origin intact); then
// the one from the repository that shares skills with the fewest others (an
// aggregator shares with hundreds, an origin with the few that copied it);
// then the source name, so sweep order never decides. Nothing unique is
// dropped: every dropped record is, by name and description, still in the
// index.
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
