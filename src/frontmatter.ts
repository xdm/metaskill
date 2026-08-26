// Tolerant SKILL.md frontmatter reader. Deliberately NOT a YAML parser:
// real-world skill files break strict YAML (unquoted colons in descriptions),
// and inventory must survive them.
export function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]!.toLowerCase()] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
