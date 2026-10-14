/**
 * MUFF-63 — build, persist, and query the league-history index.
 *
 * Where the index lives: the same JsonStore as everything else (`data/` in
 * dev, HISTORY_BUCKET on Lambda), under `rag/`. No vector database: the
 * corpus is one league's digests — ~16 chunks a week, ~300 a season, maybe
 * a few thousand after years — and a brute-force dot product over that is
 * sub-millisecond. A vector DB would add a service to deploy, pay for, and
 * keep in sync with S3, to make a query that is already instant… instant.
 * The index is one JSON blob, rebuilt from the run archive on demand
 * (`npm run rag:build`); it is derived data and can always be regenerated.
 *
 * Two keys: `rag/chunks.json` (the corpus, readable) and `rag/index.json`
 * (chunks + vectors, what search loads). Splitting them keeps the chunk dump
 * inspectable without wading through 256 floats per entry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listRuns, loadRun, type RunRecord } from "../digest/archive.ts";
import { store } from "../store.ts";
import { chunkRules, chunkRun, selectCorpusRuns, type Chunk } from "./chunk.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedText, embedTexts } from "./embed.ts";

export const CHUNKS_KEY = "rag/chunks.json";
export const INDEX_KEY = "rag/index.json";
export const RULES_PATH = "docs/league-rules.md";

export interface IndexedChunk extends Chunk {
  vector: number[];
}

export interface HistoryIndex {
  model: string;
  dimensions: number;
  built_at: string;
  /** Run-archive keys the digests came from — the index's provenance. */
  sources: string[];
  chunks: IndexedChunk[];
}

/** What a search returns: the chunk minus its vector, plus how well it matched. */
export type Hit = Chunk & { score: number };

export class HistoryIndexMissingError extends Error {
  constructor() {
    super(
      `No league-history index at ${INDEX_KEY}. Do not retry; tell the user to run \`npm run rag:build\` (with HISTORY_BUCKET set for the deployed store).`,
    );
    this.name = "HistoryIndexMissingError";
  }
}

export async function loadCorpus(): Promise<{ chunks: Chunk[]; sources: string[] }> {
  const keys = await listRuns();
  const runs: { key: string; run: RunRecord }[] = [];
  for (const key of keys) {
    const run = await loadRun(key);
    // A synthetic week (eval fixture replayed through the pipeline) is not
    // league history, however real it reads; manual/yahoo/sleeper weeks are.
    if (run && run.facts.provenance?.source !== "synthetic") runs.push({ key, run });
  }
  const selected = selectCorpusRuns(runs);
  const chunks = selected.flatMap(({ key, run }) => chunkRun(key, run));

  const rulesFile = path.join(process.cwd(), RULES_PATH);
  if (fs.existsSync(rulesFile)) chunks.push(...chunkRules(fs.readFileSync(rulesFile, "utf8"), RULES_PATH));

  return { chunks, sources: selected.map((s) => s.key) };
}

export async function buildIndex(): Promise<HistoryIndex> {
  const { chunks, sources } = await loadCorpus();
  const vectors = await embedTexts(chunks.map((c) => c.text));
  const index: HistoryIndex = {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    built_at: new Date().toISOString(),
    sources,
    chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i] })),
  };
  await store.write(CHUNKS_KEY, chunks);
  await store.write(INDEX_KEY, index);
  return index;
}

/** Cached per process: a warm Lambda or a long-lived stdio server loads the blob once. */
let cached: HistoryIndex | null = null;

export async function loadIndex(): Promise<HistoryIndex> {
  if (cached) return cached;
  const index = await store.read<HistoryIndex>(INDEX_KEY);
  if (!index) throw new HistoryIndexMissingError();
  cached = index;
  return index;
}

/** Pure ranking: unit vectors in, so dot product == cosine. Exported for tests. */
export function rank(query: number[], chunks: IndexedChunk[], k: number): Hit[] {
  return chunks
    .map(({ vector, ...chunk }) => ({ ...chunk, score: round(dot(query, vector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function searchHistory(query: string, k = 5): Promise<Hit[]> {
  const index = await loadIndex();
  const vector = await embedText(query);
  return rank(vector, index.chunks, k);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
