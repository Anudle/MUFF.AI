/**
 * MUFF-71 — bundle the league site into dist/site/ (index.html, style.css,
 * app.js). That folder is exactly what gets uploaded to the site/ prefix; it
 * deliberately does NOT contain season.json — the digest run owns that file,
 * and a laptop upload must never overwrite it with stale numbers.
 *
 *   npm run site:bundle
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

export const OUT_DIR = path.join(process.cwd(), "dist", "site");

export async function bundleSite(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await build({
    entryPoints: ["web/app.ts"],
    outfile: path.join(OUT_DIR, "app.js"),
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    logLevel: "warning",
  });
  for (const file of ["index.html", "style.css"]) {
    fs.copyFileSync(path.join("web", file), path.join(OUT_DIR, file));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/site-bundle.ts")) {
  await bundleSite();
  console.log(`Bundled the league site into ${path.relative(process.cwd(), OUT_DIR)}/ (${fs.readdirSync(OUT_DIR).join(", ")})`);
}
