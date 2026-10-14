/**
 * MUFF-63 — the RAG corpus: past digests + the league rules, cut into chunks.
 *
 * Section-level chunks, not fixed-token windows. A digest is already written
 * in self-contained units — one headline, one recap paragraph, one line per
 * team in the power rankings — and a callback the model might make ("Barry
 * was 0-3 in week 3") lives inside exactly one of those units. Fixed 512-token
 * windows would stitch the end of one team's line to the start of the next
 * and make the retrieved text cite two teams at once; section chunks keep
 * every chunk about one thing, with metadata saying which thing.
 *
 * Pure: no I/O here. `index.ts` decides where runs and rules come from.
 */

import type { RunRecord } from "../digest/archive.ts";

export type ChunkSection = "headline" | "recap" | "power_ranking" | "rules";

export interface Chunk {
  /** Stable, human-readable: `2026-w03-power_ranking-04`, `rules-scoring`. */
  id: string;
  section: ChunkSection;
  /** Absent on rules chunks — rules are not about a week. */
  season?: string;
  week?: number;
  /** Power-ranking chunks only. */
  team?: string;
  rank?: number;
  /** Rules chunks only: the `##` heading the chunk came from. */
  title?: string;
  /** What gets embedded and what the agent reads back. Week-prefixed so the vector carries "when". */
  text: string;
  /** Run-archive key or the rules file — what to open to verify a chunk. */
  source: string;
}

const pad = (week: number) => String(week).padStart(2, "0");

/**
 * One record per (season, week). The archive keeps every run — dry runs,
 * retries, rehearsals — but the league only ever read one digest per week.
 * Prefer the delivered record (what the chat saw); among ties, the newest.
 */
export function selectCorpusRuns(runs: { key: string; run: RunRecord }[]): { key: string; run: RunRecord }[] {
  const byWeek = new Map<string, { key: string; run: RunRecord }>();
  for (const entry of runs) {
    const id = `${entry.run.season}:${entry.run.week}`;
    const current = byWeek.get(id);
    if (!current || better(entry.run, current.run)) byWeek.set(id, entry);
  }
  return [...byWeek.values()].sort(
    (a, b) => a.run.season.localeCompare(b.run.season) || a.run.week - b.run.week,
  );
}

function better(candidate: RunRecord, incumbent: RunRecord): boolean {
  if (candidate.delivery_attempted !== incumbent.delivery_attempted) return candidate.delivery_attempted;
  return candidate.finished_at > incumbent.finished_at;
}

export function chunkRun(key: string, run: RunRecord): Chunk[] {
  const { season, week, digest } = run;
  const prefix = `${season}-w${pad(week)}`;
  const when = `Week ${week} (${season} season)`;
  const chunks: Chunk[] = [
    {
      id: `${prefix}-headline`,
      section: "headline",
      season,
      week,
      text: `${when} headline: ${digest.headline}`,
      source: key,
    },
    {
      id: `${prefix}-recap`,
      section: "recap",
      season,
      week,
      text: `${when} recap: ${digest.recap}`,
      source: key,
    },
  ];
  for (const p of [...digest.power_rankings].sort((a, b) => a.rank - b.rank)) {
    chunks.push({
      id: `${prefix}-power_ranking-${pad(p.rank)}`,
      section: "power_ranking",
      season,
      week,
      team: p.team,
      rank: p.rank,
      text: `${when} power rankings, #${p.rank} ${p.team}: ${p.comment}`,
      source: key,
    });
  }
  return chunks;
}

/**
 * The rules file is hand-written markdown; every `##` heading is one chunk.
 * Text before the first heading (the title, an intro line) is dropped.
 */
export function chunkRules(markdown: string, source = "docs/league-rules.md"): Chunk[] {
  const chunks: Chunk[] = [];
  const sections = markdown.split(/^## +/m).slice(1);
  for (const section of sections) {
    const [titleLine, ...rest] = section.split("\n");
    const title = titleLine.trim();
    const body = rest.join("\n").trim();
    if (!title || !body) continue;
    chunks.push({
      id: `rules-${slug(title)}`,
      section: "rules",
      title,
      text: `League rules — ${title}: ${body}`,
      source,
    });
  }
  return chunks;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
