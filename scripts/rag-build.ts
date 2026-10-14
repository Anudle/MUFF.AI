/**
 * MUFF-63 — (re)build the league-history index from the run archive.
 *
 *   npm run rag:build                                  → data/rag/{chunks,index}.json
 *   HISTORY_BUCKET=muff-digest-history-<acct> npm run rag:build   → the deployed store
 *
 * Reads runs from, and writes the index to, whatever store.ts points at —
 * so the deployed index is built from the deployed archive, never from a
 * laptop's dry runs.
 */

import { buildIndex, CHUNKS_KEY, INDEX_KEY } from "../src/rag/index.ts";
import { storeLabel } from "../src/store.ts";

const index = await buildIndex();
const bySection = new Map<string, number>();
for (const c of index.chunks) bySection.set(c.section, (bySection.get(c.section) ?? 0) + 1);

console.log(`Indexed ${index.chunks.length} chunks from ${index.sources.length} digest(s) with ${index.model} (${index.dimensions}d)`);
for (const [section, n] of bySection) console.log(`  ${section.padEnd(14)} ${n}`);
console.log(`Sources:\n  ${index.sources.join("\n  ")}`);
console.log(`Wrote ${storeLabel}${CHUNKS_KEY} and ${storeLabel}${INDEX_KEY}`);
