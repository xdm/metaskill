import fs from "node:fs";
import path from "node:path";
import { metaskillHome } from "../paths.js";
import { isIndexFile } from "./read.js";

const ASSET = "https://github.com/xdm/metaskill/releases/download/index-latest/index.json";

export interface RefreshOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  dir?: string;
}

// Never throws: `sync` runs in a SessionStart hook, and a network problem must
// not cost the user their session. Writes to a temp file and renames, so a
// killed process can never leave a half-written index behind.
export async function refreshIndex(
  opts: RefreshOpts = {},
): Promise<{ updated: boolean; skillCount?: number; reason?: string }> {
  // `sync` calls this with no injected fetch, and integration tests exercise
  // `sync` by spawning the real built CLI as a subprocess — there's no
  // in-process seam to hand it a stub fetchImpl across that boundary. The
  // test harness sets this instead, so `npm test` never reaches the network.
  // Never set by a real user session; only the test harness's own spawned
  // env carries it.
  // Set-and-non-empty, not bare truthiness: `METASKILL_SKIP_INDEX_REFRESH=0`
  // and `=false` are how a user turns a switch OFF, and under truthiness both
  // turned the skip ON — silently costing them every index refresh. Same
  // idiom as METASKILL_SKILLS_CMD in paths.ts.
  const skip = process.env.METASKILL_SKIP_INDEX_REFRESH;
  if (skip && skip.trim().length > 0 && skip !== "0" && skip.toLowerCase() !== "false") {
    return { updated: false, reason: "skipped (METASKILL_SKIP_INDEX_REFRESH)" };
  }
  const dir = opts.dir ?? metaskillHome();
  const dest = path.join(dir, "index.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  const ctrl = new AbortController();
  // The real asset is ~23.8MB (23,775,671 bytes measured). A 20s budget was
  // measured aborting mid-download on a fast connection (three real runs:
  // 11.98s, 19.91s, and one that exceeded 20s and got cut off) — do not
  // "tidy" this back down without re-measuring against the current asset size.
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(ASSET, { signal: ctrl.signal });
    if (!res.ok) return { updated: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    // isIndexFile also rejects a schemaVersion this build does not understand:
    // a future index format must never overwrite the one the running code can
    // still read correctly, because every field it gets wrong is a field
    // policy decides on.
    if (!isIndexFile(parsed) || !parsed.skills.length) {
      return { updated: false, reason: "not a valid index" };
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, dest);
    return { updated: true, skillCount: parsed.skills.length };
  } catch (err) {
    return { updated: false, reason: (err as Error).message };
  } finally {
    clearTimeout(timer);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the rename already consumed it */
    }
  }
}
