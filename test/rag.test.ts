/**
 * MUFF-63 — the pure half of the retrieval seam: how a digest becomes chunks,
 * which archived run represents a week, and that ranking is cosine over the
 * stored vectors. Embedding (Bedrock) and the store are not touched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunRecord } from "../src/digest/archive.ts";
import { chunkRules, chunkRun, selectCorpusRuns } from "../src/rag/chunk.ts";
import { rank, type IndexedChunk } from "../src/rag/index.ts";

function run(over: Partial<RunRecord>): RunRecord {
  return {
    run_id: "r",
    started_at: "2026-09-29T19:21:09Z",
    finished_at: "2026-09-29T19:21:30Z",
    duration_ms: 1,
    season: "2026",
    week: 3,
    delivery_attempted: true,
    cost: { model: "m", input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, cost_usd: 0 },
    facts: {} as RunRecord["facts"],
    digest: {
      headline: "Cow Bellz ring the alarm",
      recap: "Kyle's Cow Bellz detonated the week with a league-high 96.",
      power_rankings: [
        { rank: 2, team: "Tuten Under the Covers", comment: "3-0, W3." },
        { rank: 1, team: "This One's for John", comment: "3-0 with 219 points." },
      ],
    },
    text: "",
    ...over,
  };
}

test("chunkRun: one chunk per headline, recap and ranking line, week-prefixed, with metadata", () => {
  const chunks = chunkRun("runs/2026-w03-x.json", run({}));
  assert.deepEqual(
    chunks.map((c) => c.id),
    ["2026-w03-headline", "2026-w03-recap", "2026-w03-power_ranking-01", "2026-w03-power_ranking-02"],
  );
  for (const c of chunks) {
    assert.equal(c.season, "2026");
    assert.equal(c.week, 3);
    assert.equal(c.source, "runs/2026-w03-x.json");
    assert.match(c.text, /^Week 3 \(2026 season\)/);
  }
  const first = chunks[2];
  assert.equal(first.team, "This One's for John");
  assert.equal(first.rank, 1);
  assert.match(first.text, /#1 This One's for John: 3-0 with 219 points\./);
});

test("selectCorpusRuns: one record per week — delivered beats dry, newest breaks ties", () => {
  const dryNewer = { key: "runs/2026-w03-c.json", run: run({ delivery_attempted: false, finished_at: "2026-09-30T00:00:00Z" }) };
  const sentOld = { key: "runs/2026-w03-a.json", run: run({ finished_at: "2026-09-29T00:00:00Z" }) };
  const sentNew = { key: "runs/2026-w03-b.json", run: run({ finished_at: "2026-09-29T12:00:00Z" }) };
  const w1 = { key: "runs/2026-w01-a.json", run: run({ week: 1, delivery_attempted: false }) };
  const picked = selectCorpusRuns([dryNewer, sentOld, w1, sentNew]);
  assert.deepEqual(picked.map((p) => p.key), ["runs/2026-w01-a.json", "runs/2026-w03-b.json"]);
});

test("chunkRules: one chunk per ## heading, intro dropped", () => {
  const md = "# League rules\n\nIntro line.\n\n## Scoring\nPPR. 6 per TD.\n\n## Playoffs\nTop 6, weeks 15-17.\n\n## Empty\n\n";
  const chunks = chunkRules(md, "docs/league-rules.md");
  assert.deepEqual(chunks.map((c) => c.id), ["rules-scoring", "rules-playoffs"]);
  assert.equal(chunks[0].section, "rules");
  assert.equal(chunks[0].week, undefined);
  assert.equal(chunks[0].text, "League rules — Scoring: PPR. 6 per TD.");
});

test("rank: cosine over unit vectors, top-k, vectors stripped from hits", () => {
  const mk = (id: string, vector: number[]): IndexedChunk => ({ id, section: "recap", text: id, source: "s", vector });
  const chunks = [mk("far", [0, 1, 0]), mk("near", [1, 0, 0]), mk("mid", [Math.SQRT1_2, Math.SQRT1_2, 0])];
  const hits = rank([1, 0, 0], chunks, 2);
  assert.deepEqual(hits.map((h) => [h.id, h.score]), [["near", 1], ["mid", 0.707]]);
  assert.ok(!("vector" in hits[0]), "hits carry no vectors");
});
