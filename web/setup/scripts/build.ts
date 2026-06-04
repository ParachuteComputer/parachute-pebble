/**
 * Build the Parachute Pebble setup page.
 *
 * Deliberately tiny — no framework, no npm runtime deps. We bundle the single TS
 * entry (`main.ts`, which imports the hand-vendored `oauth.ts`) with `Bun.build`
 * and copy the static shell next to it. Everything in `dist/` is referenced with
 * RELATIVE `./` URLs so the page works under the project-Pages base path
 * (`/parachute-pebble/`) without any rewriting.
 *
 * Output layout (flat — matches the relative refs in src/index.html):
 *   dist/index.html
 *   dist/404.html   — GitHub Pages SPA fallback for the /oauth/callback leg
 *   dist/main.js
 *   dist/style.css
 *   dist/icon.svg
 */

import { copyFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

const pkgDir = path.resolve(import.meta.dir, "..");
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

// 1. Bundle the TS entry → dist/main.js (oauth.ts inlined).
const result = await Bun.build({
  entrypoints: [path.join(srcDir, "main.ts")],
  outdir: distDir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[dir]/[name].[ext]",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("pebble setup build failed");
}

// 2. Copy the static shell + assets verbatim. 404.html is the GitHub Pages SPA
//    fallback that bounces the /oauth/callback leg (which has no static file)
//    back to the index, preserving the ?code&state query.
for (const file of ["index.html", "404.html", "style.css", "icon.svg"]) {
  await copyFile(path.join(srcDir, file), path.join(distDir, file));
}

console.log(`[pebble-setup] built ${result.outputs.length} JS file(s) → ${distDir}`);
