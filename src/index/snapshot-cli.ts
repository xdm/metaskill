import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "../paths.js";
import { buildSnapshot } from "./snapshot.js";
import type { IndexFile } from "./types.js";

const ASSET = "https://github.com/xdm/metaskill/releases/download/index-latest/index.json";

const res = await fetch(ASSET);
if (!res.ok) {
  process.stderr.write(`snapshot: cannot fetch the index (${res.status})\n`);
  process.exit(1);
}
const full = (await res.json()) as IndexFile;
const snap = buildSnapshot(full);
const out = path.join(packageRoot(), "index-snapshot.json");
fs.writeFileSync(out, JSON.stringify(snap));
process.stdout.write(`snapshot: ${snap.skillCount} skills, ${(fs.statSync(out).size / 1048576).toFixed(2)} MB -> ${out}\n`);
