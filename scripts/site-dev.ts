/**
 * MUFF-71 — local preview of the league site: bundles web/, serves dist/site/
 * and answers /season.json from the local store (data/site/season.json, made
 * by `npm run site:snapshot`). Mirrors production, where CloudFront serves
 * the static files and the snapshot from the same site/ prefix.
 *
 *   npm run site:dev        → http://localhost:4173
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { bundleSite, OUT_DIR } from "./site-bundle.ts";

const PORT = Number(process.env.PORT ?? 4173);
const SNAPSHOT = path.join(process.cwd(), "data", "site", "season.json");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
};

await bundleSite();
if (!fs.existsSync(SNAPSHOT)) console.warn("No data/site/season.json yet — run `npm run site:snapshot` first.");

http
  .createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://x").pathname) || "index.html";
    const file = name === "season.json" ? SNAPSHOT : path.join(OUT_DIR, name);
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    });
  })
  .listen(PORT, () => console.log(`League site preview: http://localhost:${PORT}`));
