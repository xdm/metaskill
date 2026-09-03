// Tolerant SKILL.md frontmatter reader. Deliberately NOT a YAML parser:
// real-world skill files break strict YAML (unquoted colons in descriptions),
// and inventory must survive them.
//
// The one YAML construct it does read is the block scalar — `description: |`,
// `>`, `>-`, `|-`, `|+`, `>+` — because a fifth of the registry writes its
// descriptions that way (8,971 of 43,860 records when this was measured) and
// keeping the marker is worse than useless: the row then ranks on its name
// alone and tells its reader nothing. Keys are still recognised at column 0
// only, so a block's body — indented by definition — can never be mistaken
// for the next key, colons and all.
const BLOCK_HEADER = /^([|>])([+-]?)$/;

export function parseFrontmatter(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = (m[2] ?? "").trim();
    const header = value.match(BLOCK_HEADER);
    if (!header) {
      out[key] = value.replace(/^["']|["']$/g, "");
      continue;
    }
    // The block's body is every following line that is blank or indented —
    // it ends at the next key or the closing `---`, and `i` is left on that
    // terminator so the loop reads it next.
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j]!;
      if (next.trim() !== "" && !/^[ \t]/.test(next)) break;
      body.push(next);
    }
    i = j - 1;
    const folded = foldBlockScalar(body, header[1]!, header[2]!);
    // A marker over nothing is not a description. Leaving the key unset makes
    // every caller's missing-field path handle it, instead of publishing `>`.
    if (folded !== "") out[key] = folded;
  }
  return out;
}

// YAML 1.2 §8.1.1: `|` keeps the line breaks, `>` folds each one into a space
// and each blank line into one break; the chomping indicator `-` strips the
// trailing break, `+` keeps every one, and the default clips to exactly one.
// No caller here cares about trailing newlines — the function honours them
// anyway, because one that guessed could not be reused.
//
// Deliberately not implemented: YAML keeps the breaks around a *more*-indented
// line inside a folded block. These are one-paragraph descriptions and every
// reader of the value collapses whitespace, so such a line folds like the rest.
function foldBlockScalar(body: string[], style: string, chomp: string): string {
  let end = body.length;
  while (end > 0 && body[end - 1]!.trim() === "") end--;
  if (end === 0) return ""; // the marker stood over nothing, or over blank lines
  const indent = /^[ \t]*/.exec(body.find((l) => l.trim() !== "")!)![0].length;
  const content = body.slice(0, end).map((l) => (l.trim() === "" ? "" : dedent(l, indent)));
  const text = style === "|" ? content.join("\n") : fold(content);
  if (chomp === "-") return text;
  if (chomp === "+") return text + "\n".repeat(body.length - end + 1);
  return text + "\n";
}

// The common indentation is the first non-blank line's; a line shallower than
// that is malformed YAML, so take what is there rather than eat its text.
function dedent(line: string, width: number): string {
  let i = 0;
  while (i < width && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

function fold(content: string[]): string {
  let out = "";
  for (const line of content) {
    if (line === "") {
      out += "\n";
      continue;
    }
    if (out !== "" && !out.endsWith("\n")) out += " ";
    out += line;
  }
  return out;
}
