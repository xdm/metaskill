import fs from "node:fs";
import path from "node:path";
import { metaskillHome } from "../paths.js";
import type { IndexFile } from "./types.js";

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
  const dir = opts.dir ?? metaskillHome();
  const dest = path.join(dir, "index.json");
  const tmp = `${dest}.${process.pid}.tmp`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(ASSET, { signal: ctrl.signal });
    if (!res.ok) return { updated: false, reason: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = JSON.parse(text) as IndexFile;
    if (!Array.isArray(parsed.skills) || !parsed.skills.length) {
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
