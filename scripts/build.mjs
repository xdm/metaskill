// Bundles the CLI into a single dependency-free dist/cli.js, so metaskill can
// run straight from a plugin directory or an unpacked npm tarball, where
// nobody has run `npm install`.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

// The shebang has to stay the first line; the createRequire shim lets bundled
// CommonJS dependencies (yaml) keep working inside an ESM bundle.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __metaskillCreateRequire } from "node:module";',
  "const require = __metaskillCreateRequire(import.meta.url);",
].join("\n");

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: banner },
  legalComments: "none",
};

await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js" });
chmodSync("dist/cli.js", 0o755);

// CI-only entry: builds the registry index. Bundled the same way so the
// workflow can run it straight from a checkout with no install step.
await build({ ...common, entryPoints: ["src/index/cli.ts"], outfile: "dist/index-builder.js" });
chmodSync("dist/index-builder.js", 0o755);
