// Bundles the mcp-server's 2 entry points into dist/.
//
// @tratto/shared is an internal workspace package (protocol types/consts) —
// it is NOT published to npm, so it must be inlined into the bundle rather
// than left as an external `import`. The 3 real runtime deps
// (@modelcontextprotocol/sdk, ws, zod) are ordinary npm packages that end
// users installing `tratto-mcp-server` will get via npm's own dependency
// resolution, so they stay external (not bundled) to avoid duplicating them.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

await esbuild.build({
  entryPoints: [
    path.join(__dirname, "src/index.ts"),
    path.join(__dirname, "src/test-client.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outdir,
  sourcemap: true,
  external: ["@modelcontextprotocol/sdk", "ws", "zod"],
});

console.log(`[build] mcp-server bundled to ${outdir}`);
