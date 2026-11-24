/**
 * MUFF-71 — bundle the league site into dist/site/ (index.html, style.css,
 * app.js). That folder is exactly what gets uploaded to the site/ prefix; it
 * deliberately does NOT contain season.json — the digest run owns that file,
 * and a laptop upload must never overwrite it with stale numbers. The copied
 * index.html references app.js and style.css with a content-hash query, so a
 * re-upload is picked up by browsers that cached the previous files.
 *
 *   npm run site:bundle
 */

import * as crypto from "node:crypto";
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
  fs.copyFileSync(path.join("web", "style.css"), path.join(OUT_DIR, "style.css"));

  // Stamp the script and stylesheet URLs with a content hash. The bucket sets
  // no Cache-Control, so a browser that has seen the site keeps its old app.js
  // for a while by heuristic — and a new index.html with an old app.js shows
  // empty sections. A changed query string is a new URL to the browser; the
  // distribution forwards no query strings, so S3 still sees plain app.js.
  const stamp = (file: string) =>
    crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT_DIR, file))).digest("hex").slice(0, 10);
  const html = fs
    .readFileSync(path.join("web", "index.html"), "utf8")
    .replace('href="style.css"', `href="style.css?v=${stamp("style.css")}"`)
    .replace('src="app.js"', `src="app.js?v=${stamp("app.js")}"`);
  if (!html.includes("app.js?v=") || !html.includes("style.css?v=")) {
    throw new Error("web/index.html no longer references app.js and style.css the way site-bundle.ts stamps them.");
  }
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/site-bundle.ts")) {
  await bundleSite();
  console.log(`Bundled the league site into ${path.relative(process.cwd(), OUT_DIR)}/ (${fs.readdirSync(OUT_DIR).join(", ")})`);
}
