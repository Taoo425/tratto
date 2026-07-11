// Bundles the extension's 3 entry points into dist/, and copies manifest.json
// alongside them so dist/ is a directly loadable "unpacked extension" folder.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync, copyFileSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

mkdirSync(outdir, { recursive: true });

// background.js: MV3 service worker, declared as "type": "module" in the
// manifest, so ESM output is fine (and lets us keep import syntax).
await esbuild.build({
  entryPoints: [path.join(__dirname, "src/background.ts")],
  bundle: true,
  format: "esm",
  target: "chrome110",
  outfile: path.join(outdir, "background.js"),
  sourcemap: true,
});

// Content scripts (and the popup script) are loaded directly by Chrome (not
// as ES modules), so they must be self-contained IIFEs with no import/export
// syntax left in the output.
for (const name of ["content-isolated", "content-main", "popup"]) {
  await esbuild.build({
    entryPoints: [path.join(__dirname, `src/${name}.ts`)],
    bundle: true,
    format: "iife",
    target: "chrome110",
    outfile: path.join(outdir, `${name}.js`),
    sourcemap: true,
  });
}

copyFileSync(path.join(__dirname, "manifest.json"), path.join(outdir, "manifest.json"));
copyFileSync(path.join(__dirname, "src/popup.html"), path.join(outdir, "popup.html"));

console.log(`[build] extension bundled to ${outdir}`);
