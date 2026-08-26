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

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: banner },
  legalComments: "none",
});

chmodSync("dist/cli.js", 0o755);
