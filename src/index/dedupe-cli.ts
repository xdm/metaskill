import fs from "node:fs";
import { dedupeIndex } from "./dedupe.js";
import type { IndexFile } from "./types.js";

// CI entry point for the publish gate: prints the skill count an index file
// would have after dedupeIndex. The gate compares today's build against the
// published asset, and the build now dedupes while the published asset may
// predate that — so the gate runs BOTH through the same function and
// compares like with like. Idempotent on an already-deduped file.
const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: index-dedupe <index.json>\n");
  process.exit(2);
}
const index = JSON.parse(fs.readFileSync(file, "utf8")) as IndexFile;
process.stdout.write(`${dedupeIndex(index.skills).skills.length}\n`);
