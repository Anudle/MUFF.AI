/**
 * MUFF-63 — query the index from the CLI.
 *
 *   npm run rag:search -- "Who had the worst beat of the season?"
 *   npm run rag:search -- --k 3 "Barry"
 */

import { searchHistory } from "../src/rag/index.ts";

const argv = process.argv.slice(2);
const kFlag = argv.indexOf("--k");
const k = kFlag >= 0 ? Number(argv[kFlag + 1]) : 5;
const query = argv.filter((_, i) => i !== kFlag && i !== kFlag + 1).join(" ").trim();
if (!query) {
  console.error('usage: npm run rag:search -- [--k N] "your question"');
  process.exit(2);
}

const hits = await searchHistory(query, k);
for (const h of hits) {
  const when = h.week ? `${h.season} w${h.week}` : "rules";
  console.log(`${h.score.toFixed(3)}  [${when} · ${h.section}${h.team ? ` · ${h.team}` : ""}]  ${h.text.slice(0, 160)}${h.text.length > 160 ? "…" : ""}`);
}
